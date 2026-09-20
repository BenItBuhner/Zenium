/**
 * `chrome.contentSettings`, the part shared by the hosts: Chrome's content-setting types with the
 * values each accepts and the row of Zenium's content-settings catalogue (`shared/contentSettings`)
 * each stands for, Chrome's content-settings pattern grammar (a match pattern whose path may only
 * be `/*`, `file:` patterns aside), the checks of `get` / `set` / `clear`'s details, and the
 * precedence of rules (a more specific primary pattern wins, then the more specific secondary
 * one; a rule set again for the same pair of patterns replaces the earlier one). Precedence
 * between extensions is the hosts' business (the most recently installed wins, as for every
 * `ChromeSetting`).
 */

import { parseMatchPattern, type MatchPattern } from './matchPattern'
import type { ContentDefault } from '../../../shared/contentSettings'

export type ContentSettingScope = 'regular' | 'incognito_session_only'

export const CONTENT_SETTING_SCOPES: readonly ContentSettingScope[] = [
  'regular',
  'incognito_session_only'
]

export interface ContentSettingTypeSpec {
  /** Chrome's member name: `contentSettings.<name>`. */
  name: string
  /** The catalogue row the rules apply to; null when Zenium has no such feature (the rules are kept and reported). */
  permission: string | null
  /** The `setting` values Chrome accepts for the type. */
  values: readonly string[]
  /**
   * A type Chrome retired: `set` is accepted and does nothing, `get` always answers this value
   * (Chrome: plugins and unsandboxed plugins are always blocked since Flash went, fullscreen
   * and mouselock always allowed).
   */
  fixed?: string
  /** Whether a rule may name a secondary pattern that is not the wildcard (Chrome: cookies). */
  embedded?: boolean
  /** What sites get when neither an extension nor the user decided (types outside the catalogue). */
  fallback?: string
}

export const CONTENT_SETTING_TYPES: readonly ContentSettingTypeSpec[] = [
  {
    name: 'cookies',
    permission: 'on-device-site-data',
    values: ['allow', 'block', 'session_only'],
    embedded: true
  },
  { name: 'images', permission: 'images', values: ['allow', 'block'] },
  { name: 'javascript', permission: 'javascript', values: ['allow', 'block'] },
  { name: 'location', permission: 'geolocation', values: ['allow', 'block', 'ask'] },
  { name: 'plugins', permission: null, values: ['allow', 'block', 'ask'], fixed: 'block' },
  { name: 'popups', permission: 'popups', values: ['allow', 'block'] },
  { name: 'notifications', permission: 'notifications', values: ['allow', 'block', 'ask'] },
  { name: 'fullscreen', permission: 'fullscreen', values: ['allow'], fixed: 'allow' },
  { name: 'mouselock', permission: 'pointerLock', values: ['allow'], fixed: 'allow' },
  { name: 'microphone', permission: 'microphone', values: ['allow', 'block', 'ask'] },
  { name: 'camera', permission: 'camera', values: ['allow', 'block', 'ask'] },
  {
    name: 'unsandboxedPlugins',
    permission: null,
    values: ['allow', 'block', 'ask'],
    fixed: 'block'
  },
  {
    name: 'automaticDownloads',
    permission: 'automatic-downloads',
    values: ['allow', 'block', 'ask']
  },
  { name: 'clipboard', permission: 'clipboard-read', values: ['allow', 'block', 'ask'] },
  // Private State Tokens (Chrome 113): no such feature here, the rules are kept and reported.
  { name: 'autoVerify', permission: null, values: ['allow', 'block'], fallback: 'allow' }
]

export const CONTENT_SETTING_TYPE_NAMES: readonly string[] = CONTENT_SETTING_TYPES.map(
  (type) => type.name
)

export const CONTENT_SETTING_METHODS = ['get', 'set', 'clear', 'getResourceIdentifiers'] as const

const BY_NAME = new Map(CONTENT_SETTING_TYPES.map((type) => [type.name, type]))
const BY_PERMISSION = new Map(
  CONTENT_SETTING_TYPES.filter((type) => type.permission !== null).map((type) => [
    type.permission as string,
    type
  ])
)

export function contentSettingType(name: unknown): ContentSettingTypeSpec | undefined {
  return typeof name === 'string' ? BY_NAME.get(name) : undefined
}

/** The type whose rules decide a catalogue permission (`geolocation` is `location`'s), if any. */
export function contentSettingTypeFor(permission: string): ContentSettingTypeSpec | undefined {
  return BY_PERMISSION.get(permission)
}

// Chrome's messages (content_settings_api_constants.cc and the URLPattern parser).
export const INVALID_URL_ERROR = (url: string): string => `The URL "${url}" is invalid.`
export const NO_INCOGNITO_WINDOW_ERROR =
  'You cannot read incognito content settings when no incognito window is open.'
export const SPECIFIC_PATH_ERROR = 'Specific paths are not allowed.'
export const EMBEDDED_PATTERN_ERROR = 'Embedded patterns are not supported for this setting.'
export const INVALID_PATTERN_ERROR = (pattern: string): string =>
  `The pattern "${pattern}" is invalid.`
export const UNSUPPORTED_SETTING_ERROR = (setting: string): string =>
  `'${setting}' is not supported for this setting.`
export const INVALID_SETTING_ERROR = 'Invalid value for setting.'

/** The pattern that stands for "any site" (`<all_urls>`; a rule's secondary pattern by default). */
export const WILDCARD_PATTERN = '<all_urls>'

/**
 * A content-settings pattern, taken apart: the match pattern it was given as, with the port a
 * URL is compared against (an explicit one, `*`, or none: any port).
 */
export interface ContentSettingsPattern extends MatchPattern {
  /** The pattern as the extension wrote it, lower-cased where case has no meaning. */
  source: string
}

/**
 * Chrome's `ParseExtensionPattern`: a match pattern over http, https and file (`*` stands for
 * http and https, `<all_urls>` for every scheme), a port allowed, and no path other than `/*`
 * unless the scheme is `file`, where the path is exact or `/*`. Returns the error message for a
 * pattern Chrome refuses.
 */
export function parseContentSettingsPattern(raw: unknown): ContentSettingsPattern | string {
  if (typeof raw !== 'string') return INVALID_PATTERN_ERROR(String(raw))
  const parsed = parseMatchPattern(raw)
  if (!parsed) return INVALID_PATTERN_ERROR(raw)
  if (!parsed.matchesAllUrls) {
    const allowed = parsed.schemes.every((scheme) => CONTENT_SCHEMES.has(scheme))
    if (!allowed) return INVALID_PATTERN_ERROR(raw)
    const isFile = parsed.schemes.length === 1 && parsed.schemes[0] === 'file'
    if (!isFile && parsed.path !== '/*') return SPECIFIC_PATH_ERROR
  }
  return { ...parsed, source: parsed.matchesAllUrls ? WILDCARD_PATTERN : raw.toLowerCase() }
}

const CONTENT_SCHEMES = new Set(['http', 'https', 'file'])
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
  'ftp:': '21'
}

/** Whether a URL is in the set a content-settings pattern names. */
export function patternMatchesUrl(pattern: ContentSettingsPattern, url: string): boolean {
  if (pattern.matchesAllUrls) return safeUrl(url) !== null
  const parsed = safeUrl(url)
  if (!parsed) return false
  const scheme = parsed.protocol.slice(0, -1)
  if (!pattern.schemes.includes(scheme)) return false
  if (scheme === 'file') {
    return pattern.path === '' || pattern.path === '/*' || pattern.path === '*'
      ? true
      : decodeURIComponent(parsed.pathname) === pattern.path
  }
  const host = parsed.hostname.toLowerCase()
  if (pattern.host === '*') {
    // Any host.
  } else if (pattern.host.startsWith('*.')) {
    const domain = pattern.host.slice(2)
    if (host !== domain && !host.endsWith(`.${domain}`)) return false
  } else if (host !== pattern.host) {
    return false
  }
  if (pattern.port !== null && pattern.port !== '*') {
    const port = parsed.port || DEFAULT_PORTS[parsed.protocol] || ''
    if (port !== pattern.port) return false
  }
  return true
}

/**
 * Chrome's `ContentSettingsPattern::Compare`, as a number to sort by: a larger value is the more
 * specific pattern. The host decides first (an exact host over a domain wildcard over any host,
 * the longer domain over the shorter), then an explicit port, then an explicit scheme, then a
 * path, each over its wildcard.
 */
export function patternSpecificity(pattern: ContentSettingsPattern): number {
  if (pattern.matchesAllUrls) return 0
  const host = pattern.host === '*' ? 0 : pattern.host.startsWith('*.') ? 1 : 2
  const domain = pattern.host === '*' ? 0 : Math.min(labels(pattern.host.replace(/^\*\./, '')), 99)
  const port = pattern.port !== null && pattern.port !== '*' ? 1 : 0
  const scheme = pattern.schemes.length === 1 ? 1 : 0
  const path = pattern.path !== '/*' && pattern.path !== '' && pattern.path !== '*' ? 1 : 0
  return 1 + host * 1_000_000 + domain * 10_000 + port * 1_000 + scheme * 100 + path * 10
}

function labels(host: string): number {
  return host.split('.').filter(Boolean).length
}

/** One rule an extension set: the patterns as written, the value and the scope. */
export interface ContentSettingRule {
  primaryPattern: string
  secondaryPattern: string
  setting: string
  scope: ContentSettingScope
}

export interface GetDetails {
  primaryUrl: string
  secondaryUrl: string
  incognito: boolean
}

export interface SetDetails {
  primary: ContentSettingsPattern
  secondary: ContentSettingsPattern
  setting: string
  scope: ContentSettingScope
}

export interface ClearDetails {
  scope: ContentSettingScope
}

function record(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function scopeOf(raw: unknown): ContentSettingScope | string {
  if (raw === undefined || raw === null) return 'regular'
  if (raw === 'regular' || raw === 'incognito_session_only') return raw
  return `Invalid value for scope: ${String(raw)}.`
}

/** `get`'s details checked; the error message when Chrome would refuse them. */
export function normalizeGetDetails(raw: unknown): GetDetails | string {
  const details = record(raw)
  const primaryUrl = details.primaryUrl
  if (typeof primaryUrl !== 'string' || !safeUrl(primaryUrl))
    return INVALID_URL_ERROR(String(primaryUrl))
  const secondary = details.secondaryUrl
  let secondaryUrl = primaryUrl
  if (secondary !== undefined && secondary !== null) {
    if (typeof secondary !== 'string' || !safeUrl(secondary))
      return INVALID_URL_ERROR(String(secondary))
    secondaryUrl = secondary
  }
  return { primaryUrl, secondaryUrl, incognito: details.incognito === true }
}

/** `set`'s details checked against the type; the error message when Chrome would refuse them. */
export function normalizeSetDetails(
  type: ContentSettingTypeSpec,
  raw: unknown
): SetDetails | string {
  const details = record(raw)
  const primary = parseContentSettingsPattern(details.primaryPattern)
  if (typeof primary === 'string') return primary
  const secondary =
    details.secondaryPattern === undefined || details.secondaryPattern === null
      ? parseContentSettingsPattern(WILDCARD_PATTERN)
      : parseContentSettingsPattern(details.secondaryPattern)
  if (typeof secondary === 'string') return secondary
  if (!secondary.matchesAllUrls && !type.embedded) return EMBEDDED_PATTERN_ERROR
  const setting = details.setting
  if (typeof setting !== 'string') return INVALID_SETTING_ERROR
  if (!type.values.includes(setting)) return UNSUPPORTED_SETTING_ERROR(setting)
  const scope = scopeOf(details.scope)
  if (scope !== 'regular' && scope !== 'incognito_session_only') return scope
  return { primary, secondary, setting, scope }
}

/** `clear`'s details checked; the error message when Chrome would refuse them. */
export function normalizeClearDetails(raw: unknown): ClearDetails | string {
  const scope = scopeOf(record(raw).scope)
  if (scope !== 'regular' && scope !== 'incognito_session_only') return scope
  return { scope }
}

/** The same pair of patterns: a rule set again replaces the earlier one. */
export function sameRulePatterns(a: ContentSettingRule, b: ContentSettingRule): boolean {
  return (
    a.primaryPattern === b.primaryPattern &&
    a.secondaryPattern === b.secondaryPattern &&
    a.scope === b.scope
  )
}

/** A rule's patterns, parsed again (rules are stored as strings; a stored rule is always valid). */
export function rulePatterns(
  rule: ContentSettingRule
): { primary: ContentSettingsPattern; secondary: ContentSettingsPattern } | null {
  const primary = parseContentSettingsPattern(rule.primaryPattern)
  const secondary = parseContentSettingsPattern(rule.secondaryPattern)
  if (typeof primary === 'string' || typeof secondary === 'string') return null
  return { primary, secondary }
}

/**
 * Chrome's order of one extension's rules: the most specific primary pattern first, then the
 * most specific secondary pattern (rules of the same specificity keep their order).
 */
export function sortRules(rules: readonly ContentSettingRule[]): ContentSettingRule[] {
  const scored = rules.map((rule, index) => {
    const patterns = rulePatterns(rule)
    return {
      rule,
      index,
      primary: patterns ? patternSpecificity(patterns.primary) : -1,
      secondary: patterns ? patternSpecificity(patterns.secondary) : -1
    }
  })
  scored.sort((a, b) => b.primary - a.primary || b.secondary - a.secondary || a.index - b.index)
  return scored.map((entry) => entry.rule)
}

/**
 * The first rule of a sorted list whose patterns cover the pair of URLs, among the rules of the
 * given scopes (in the order given: incognito rules before regular ones for a private window).
 */
export function matchingRule(
  sorted: readonly ContentSettingRule[],
  primaryUrl: string,
  secondaryUrl: string,
  scopes: readonly ContentSettingScope[]
): ContentSettingRule | null {
  for (const scope of scopes) {
    for (const rule of sorted) {
      if (rule.scope !== scope) continue
      const patterns = rulePatterns(rule)
      if (!patterns) continue
      if (
        patternMatchesUrl(patterns.primary, primaryUrl) &&
        patternMatchesUrl(patterns.secondary, secondaryUrl)
      )
        return rule
    }
  }
  return null
}

/** Chrome's value for what the catalogue decides (`deny` is Chrome's `block`). */
export function settingOfDecision(decision: ContentDefault): string {
  return decision === 'deny' ? 'block' : decision
}

/**
 * What a rule's value means to the permission store: `block` refuses, `ask` prompts, `allow`
 * and the cookie values that let a site store grant. Null for a value no decision stands for.
 */
export function decisionOfSetting(setting: string): ContentDefault | null {
  switch (setting) {
    case 'allow':
    case 'session_only':
    case 'detect_important_content':
      return 'allow'
    case 'block':
      return 'deny'
    case 'ask':
      return 'ask'
    default:
      return null
  }
}

/** Only regular-scope rules survive a restart (Chrome: incognito_session_only ends with the session). */
export function persistedRules(rules: readonly ContentSettingRule[]): ContentSettingRule[] {
  return rules.filter((rule) => rule.scope === 'regular')
}

/** A stored rule list read back: whatever is not a rule is dropped. */
export function normalizeStoredRules(raw: unknown): ContentSettingRule[] {
  if (!Array.isArray(raw)) return []
  const out: ContentSettingRule[] = []
  for (const entry of raw) {
    const rule = record(entry)
    if (
      typeof rule.primaryPattern !== 'string' ||
      typeof rule.secondaryPattern !== 'string' ||
      typeof rule.setting !== 'string' ||
      (rule.scope !== 'regular' && rule.scope !== 'incognito_session_only')
    )
      continue
    out.push({
      primaryPattern: rule.primaryPattern,
      secondaryPattern: rule.secondaryPattern,
      setting: rule.setting,
      scope: rule.scope
    })
  }
  return out
}
