/**
 * Per-site cookie and site-data exceptions (Chrome's `chrome://settings/content/siteData`),
 * clear browsing data on exit, and the site-data viewer, as the chrome and the hosts see them.
 * The policy's shape and its pure resolution live here; the service that persists and enforces
 * it is `src/core/siteData.ts`, the pattern grammar `./sitePatterns.ts`.
 */

import type { BrowsingDataType } from './types'
import {
  compareSitePatterns,
  matchSitePatterns,
  normalizeSitePattern,
  parseSitePattern,
  type SiteAddress
} from './sitePatterns'

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * What sites on no list may do with cookies and site data:
 * - `allow`: every site can use cookies, third parties included.
 * - `block-third-party`: sites can use their own cookies; embedded third parties are governed
 *   by the third-party cookie settings (`PrivacySettings.thirdPartyCookies` and the private
 *   contexts' switch), as before this policy existed. Zenium's default.
 * - `block-all`: no site can use cookies unless a list says otherwise.
 */
export type SiteDataDefault = 'allow' | 'block-third-party' | 'block-all'

/** Chrome's three lists. */
export type SiteDataList = 'allow' | 'clearOnExit' | 'block'

export const SITE_DATA_LISTS: readonly SiteDataList[] = ['allow', 'clearOnExit', 'block']

/**
 * The persisted policy (`sitedata.json`, and the `site-data` sync record). The default's
 * `allow` / `block-third-party` half lives in `PrivacySettings.thirdPartyCookies` (one source
 * for the third-party choice); `blockAll` is the extra state the third-party setting cannot say.
 */
export interface SiteDataPolicy {
  blockAll: boolean
  /** Sites that can always use cookies, as patterns (`sitePatterns.ts`). */
  allow: string[]
  /** Sites whose cookies and data are cleared when the browser closes (Android: at the next launch). */
  clearOnExit: string[]
  /** Sites that can never use cookies. */
  block: string[]
}

export const DEFAULT_SITE_DATA_POLICY: SiteDataPolicy = {
  blockAll: false,
  allow: [],
  clearOnExit: [],
  block: []
}

/** Patterns per list; Chrome has no cap, this keeps a synced document bounded. */
export const SITE_DATA_LIST_LIMIT = 1000

/** A pattern may sit on one list only; a pattern moved to another list leaves the first. */
export function sanitizeSiteDataPolicy(input: unknown): SiteDataPolicy {
  const raw = (input ?? {}) as Partial<Record<keyof SiteDataPolicy, unknown>>
  const seen = new Set<string>()
  const list = (value: unknown): string[] => {
    const out: string[] = []
    if (!Array.isArray(value)) return out
    for (const item of value) {
      if (typeof item !== 'string') continue
      const pattern = normalizeSitePattern(item)
      if (!pattern || seen.has(pattern)) continue
      seen.add(pattern)
      out.push(pattern)
      if (out.length >= SITE_DATA_LIST_LIMIT) break
    }
    return out
  }
  // The block list is read first so a pattern found on two lists stays blocked (the stricter word).
  const block = list(raw.block)
  const clearOnExit = list(raw.clearOnExit)
  const allow = list(raw.allow)
  return { blockAll: raw.blockAll === true, allow, clearOnExit, block }
}

/** The policy as JSON the store and the sync record carry (lists sorted, most specific first). */
export function siteDataPolicyEquals(a: SiteDataPolicy, b: SiteDataPolicy): boolean {
  return (
    a.blockAll === b.blockAll &&
    sameList(a.allow, b.allow) &&
    sameList(a.clearOnExit, b.clearOnExit) &&
    sameList(a.block, b.block)
  )
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

/** Sort a list the way the Settings page shows it: the most specific pattern first, then by text. */
export function sortSitePatterns(patterns: readonly string[]): string[] {
  return patterns
    .map((text) => parseSitePattern(text))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort(compareSitePatterns)
    .map((p) => p.text)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** What the policy says for one site: a list's word, or the default. */
export type SiteDataState = 'allow' | 'block' | 'clear-on-exit' | 'default'

export interface SiteDataResolution {
  state: SiteDataState
  /** The list entry that decided, or null for the default. */
  pattern: string | null
}

const LIST_STATE: Record<SiteDataList, SiteDataState> = {
  allow: 'allow',
  clearOnExit: 'clear-on-exit',
  block: 'block'
}

/**
 * Which list decides for the URL: the most specific pattern across the three lists wins, as
 * Chrome's content settings order theirs; on a tie between lists the block list wins, then the
 * clear-on-exit list. Nothing matching is the default.
 */
export function resolveSiteData(
  policy: SiteDataPolicy,
  url: string | SiteAddress
): SiteDataResolution {
  let best: { list: SiteDataList; pattern: ReturnType<typeof matchSitePatterns> } | null = null
  for (const list of ['block', 'clearOnExit', 'allow'] as const) {
    const pattern = matchSitePatterns(policy[list], url)
    if (!pattern) continue
    if (!best || (best.pattern && compareSitePatterns(pattern, best.pattern) < 0))
      best = { list, pattern }
  }
  if (!best?.pattern) return { state: 'default', pattern: null }
  return { state: LIST_STATE[best.list], pattern: best.pattern.text }
}

/**
 * The policy's word on a request for the URL, before the third-party rule: `blocked` for a
 * site on the never list, and under `blockAll` for every site the allow and clear-on-exit
 * lists leave out (a clear-on-exit site keeps its cookies for the session, as Chrome's
 * "session only" setting does); `allowed` for a listed site, which the third-party rule leaves
 * alone too (an explicit entry of Chrome's cookie settings does); `default` for the rest.
 */
export function cookieVerdict(
  policy: SiteDataPolicy,
  url: string | SiteAddress
): 'blocked' | 'allowed' | 'default' {
  const { state } = resolveSiteData(policy, url)
  if (state === 'block') return 'blocked'
  if (state === 'allow' || state === 'clear-on-exit') return 'allowed'
  return policy.blockAll ? 'blocked' : 'default'
}

/** Whether a request for the URL may carry no cookies at all under the policy (see {@link cookieVerdict}). */
export function cookiesBlockedFor(policy: SiteDataPolicy, url: string | SiteAddress): boolean {
  return cookieVerdict(policy, url) === 'blocked'
}

/** `siteData.add`'s answer: the canonical pattern that went on the list, or why nothing did. */
export type SiteDataAddResult = { ok: true; pattern: string } | { ok: false; problem: string }

/** What the site-information sheet shows for one page, and what adding the site to a list adds. */
export interface SiteDataSiteState {
  state: SiteDataState
  /** The list entry that decides, or null for the default. */
  pattern: string | null
  /** The pattern "Add to list" would add (`[*.]host`), or null for a page without a site. */
  addable: string | null
  default: SiteDataDefault
}

// ---------------------------------------------------------------------------
// Clear browsing data on exit
// ---------------------------------------------------------------------------

/**
 * What may be cleared when the browser closes: every type "Clear browsing data" takes but
 * passwords (Chrome never clears them on exit either). History is a per-type choice.
 */
export type ClearOnExitType = Exclude<BrowsingDataType, 'passwords'>

export const CLEAR_ON_EXIT_TYPES: readonly ClearOnExitType[] = [
  'history',
  'cookies',
  'cache',
  'downloads',
  'autofill',
  'sitePermissions',
  'recentlyClosed'
]

export interface ClearOnExitSettings {
  types: ClearOnExitType[]
}

export const DEFAULT_CLEAR_ON_EXIT: ClearOnExitSettings = { types: [] }

export function sanitizeClearOnExit(input: unknown): ClearOnExitSettings {
  const raw = (input ?? {}) as { types?: unknown }
  const types: ClearOnExitType[] = []
  if (Array.isArray(raw.types))
    for (const item of raw.types) {
      if (!CLEAR_ON_EXIT_TYPES.includes(item as ClearOnExitType)) continue
      if (!types.includes(item as ClearOnExitType)) types.push(item as ClearOnExitType)
    }
  // In the dialog's order, whatever order they were chosen in.
  types.sort((a, b) => CLEAR_ON_EXIT_TYPES.indexOf(a) - CLEAR_ON_EXIT_TYPES.indexOf(b))
  return { types }
}

// ---------------------------------------------------------------------------
// Status (UIState.siteData) and the viewer
// ---------------------------------------------------------------------------

/** The policy as the Settings page shows it. */
export interface SiteDataStatus {
  default: SiteDataDefault
  /** The lists, most specific pattern first. */
  allow: string[]
  clearOnExit: string[]
  block: string[]
  /** What is cleared when the browser closes (`Settings.privacy.clearOnExit`). */
  clearOnExitTypes: ClearOnExitType[]
  /**
   * The host runs the on-exit clearing at the next launch rather than at quit (Android: process
   * death is not observable), so the Settings page can say so.
   */
  clearsAtNextLaunch: boolean
  /** A launch-time clear is still owed (the marker from the last close is in the profile). */
  pendingClear: boolean
}

/** The status before the service exists (and of a host without the policy). */
export function emptySiteDataStatus(): SiteDataStatus {
  return {
    default: 'block-third-party',
    allow: [],
    clearOnExit: [],
    block: [],
    clearOnExitTypes: [],
    clearsAtNextLaunch: false,
    pendingClear: false
  }
}

/** One origin of the site-data viewer. */
export interface SiteDataOriginRow {
  origin: string
  /** Registrable domain the viewer groups by. */
  site: string
  cookies: number
  /** Stored data in bytes; null where the host cannot size an origin (Electron). */
  usageBytes: number | null
  /** Permission decisions the user made for the origin (`allow` / `deny`), as `permission` ids. */
  permissions: Array<{ permission: string; decision: 'allow' | 'deny' }>
  /** The policy's word for the origin. */
  state: SiteDataState
}

export interface SiteDataListing {
  rows: SiteDataOriginRow[]
  /** Every origin with data, before the cap. */
  total: number
  /** `total` is above the cap: `rows` holds the first {@link SITE_DATA_ORIGIN_CAP}. */
  truncated: boolean
  /** Whether any row could be sized (the "size unavailable" line shows when none could). */
  sized: boolean
}

/** The viewer lists this many origins at most, with a count line for the rest. */
export const SITE_DATA_ORIGIN_CAP = 1000

/**
 * The viewer's order: the most data first (an unsized origin sorts below sized ones, then by
 * cookies), ties by site then origin so the order is total.
 */
export function compareSiteDataRows(a: SiteDataOriginRow, b: SiteDataOriginRow): number {
  const ua = a.usageBytes ?? -1
  const ub = b.usageBytes ?? -1
  if (ua !== ub) return ub - ua
  if (a.cookies !== b.cookies) return b.cookies - a.cookies
  if (a.site !== b.site) return a.site < b.site ? -1 : 1
  return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0
}

export const SITE_DATA_DEFAULT_LABELS: Record<
  SiteDataDefault,
  { label: string; description: string }
> = {
  allow: {
    label: 'Allow all cookies',
    description:
      'Sites can use cookies to keep you signed in and remember your preferences, embedded sites included.'
  },
  'block-third-party': {
    label: 'Block third-party cookies',
    description:
      'Sites can use their own cookies. Sites embedded in other sites are governed by the third-party cookie setting.'
  },
  'block-all': {
    label: 'Block all cookies',
    description:
      'No site can use cookies unless it is on the allowed list. Many sites will not work as expected.'
  }
}

export const SITE_DATA_LIST_LABELS: Record<SiteDataList, string> = {
  allow: 'Sites that can always use cookies',
  clearOnExit: 'Always clear cookies when windows are closed',
  block: 'Sites that can never use cookies'
}
