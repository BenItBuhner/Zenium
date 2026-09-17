/**
 * Request blocking as the chrome sees it: tracking-prevention levels, the default filter lists,
 * the user's settings and the status card in Settings → Privacy and security. The engine itself
 * (rule contract, matching, persistence) lives in `src/core/blocking`; this module holds only
 * what the renderer needs too.
 */

/**
 * Edge-style tracking prevention levels. Each level is a fixed set of enabled rule sets:
 * - `off`: nothing is blocked (the engine still runs so per-site data stays in place).
 * - `basic`: malware hosts and known-malicious trackers only (urlhaus, uBlock badware).
 * - `balanced` (default): trackers and ads – EasyList, EasyPrivacy, uBlock filters, Peter Lowe.
 * - `strict`: `balanced` plus uBlock's privacy list; more sites may break.
 */
export type TrackingLevel = 'off' | 'basic' | 'balanced' | 'strict'

/** Which level first enables a list (a list is on for its tier and every stricter level). */
export type ListTier = 'basic' | 'balanced' | 'strict'

export interface FilterListDefinition {
  id: string
  name: string
  description: string
  /** Canonical download URL – updates always come from here. */
  url: string
  homepage: string
  licence: string
  tier: ListTier
}

/** A list the user added by URL. */
export interface CustomFilterList {
  id: string
  url: string
  /** Title from the list header once fetched, else the URL. */
  name: string
  enabled: boolean
}

export interface BlockingSettings {
  /** Master switch for ad and tracker blocking. */
  enabled: boolean
  level: TrackingLevel
  /** Per-list overrides of the level's choice (`false` turns a list off, `true` forces it on). */
  lists: Record<string, boolean>
  customLists: CustomFilterList[]
  /** The user's own filters in ABP / uBlock syntax, one per line. */
  userFilters: string
  /** Registrable domains (`example.com`) where nothing is blocked. */
  siteExceptions: string[]
  /** Refresh lists from their canonical URLs on a schedule. */
  autoUpdate: boolean
}

export const DEFAULT_BLOCKING_SETTINGS: BlockingSettings = {
  enabled: true,
  level: 'balanced',
  lists: {},
  customLists: [],
  userFilters: '',
  siteExceptions: [],
  autoUpdate: true
}

const LEVELS: TrackingLevel[] = ['off', 'basic', 'balanced', 'strict']

export const TRACKING_LEVEL_LABELS: Record<TrackingLevel, { label: string; description: string }> =
  {
    off: {
      label: 'Off',
      description: 'Nothing is blocked. Sites can load every ad and tracker they ask for.'
    },
    basic: {
      label: 'Basic',
      description:
        'Blocks malware hosts and known-malicious trackers only. Ads and most trackers load.'
    },
    balanced: {
      label: 'Balanced',
      description:
        'Blocks ads and trackers with EasyList, EasyPrivacy, uBlock Origin filters and Peter Lowe’s list. Sites keep working.'
    },
    strict: {
      label: 'Strict',
      description:
        'Adds uBlock Origin’s privacy list. Blocks the most; some sites or videos may break.'
    }
  }

/**
 * The lists Zenium ships and keeps up to date. Ids double as the file names under
 * `blocking/` in the profile and as the rule-set ids inside the engine.
 */
export const DEFAULT_FILTER_LISTS: FilterListDefinition[] = [
  {
    id: 'urlhaus',
    name: 'URLhaus malicious URL blocklist',
    description: 'Malware distribution sites reported to abuse.ch, filtered for browsers.',
    url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt',
    homepage: 'https://gitlab.com/malware-filter/urlhaus-filter',
    licence: 'CC0-1.0',
    tier: 'basic'
  },
  {
    id: 'ubo-badware',
    name: 'uBlock Origin – Badware risks',
    description: 'Sites documented to serve malware or trick users into installing it.',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    licence: 'GPL-3.0',
    tier: 'basic'
  },
  {
    id: 'easylist',
    name: 'EasyList',
    description: 'The primary filter list that removes most ads from web pages.',
    url: 'https://easylist.to/easylist/easylist.txt',
    homepage: 'https://easylist.to/',
    licence: 'GPL-3.0 / CC BY-SA 3.0',
    tier: 'balanced'
  },
  {
    id: 'easyprivacy',
    name: 'EasyPrivacy',
    description: 'Removes tracking scripts, beacons and analytics.',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    homepage: 'https://easylist.to/',
    licence: 'GPL-3.0 / CC BY-SA 3.0',
    tier: 'balanced'
  },
  {
    id: 'ubo-filters',
    name: 'uBlock Origin – Ads',
    description: 'uBlock Origin’s own filters complementing EasyList.',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    licence: 'GPL-3.0',
    tier: 'balanced'
  },
  {
    id: 'peter-lowe',
    name: 'Peter Lowe’s Ad and tracking server list',
    description: 'Ad and tracking servers, maintained since 2001.',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    homepage: 'https://pgl.yoyo.org/adservers/',
    licence: 'MCRAE GENERAL PUBLIC LICENSE',
    tier: 'balanced'
  },
  {
    id: 'ubo-privacy',
    name: 'uBlock Origin – Privacy',
    description: 'Blocks more trackers and fingerprinting; can break some sites.',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
    licence: 'GPL-3.0',
    tier: 'strict'
  }
]

const TIER_RANK: Record<TrackingLevel, number> = { off: 0, basic: 1, balanced: 2, strict: 3 }

/** Does `level` include lists of `tier`? */
export function levelIncludes(level: TrackingLevel, tier: ListTier): boolean {
  return TIER_RANK[level] >= TIER_RANK[tier]
}

/**
 * The default lists a level turns on, after the user's per-list overrides. `off` and a disabled
 * master switch enable nothing.
 */
export function enabledListsFor(settings: BlockingSettings): Set<string> {
  const out = new Set<string>()
  if (!settings.enabled || settings.level === 'off') return out
  for (const list of DEFAULT_FILTER_LISTS) {
    const override = settings.lists[list.id]
    const on = override === undefined ? levelIncludes(settings.level, list.tier) : override
    if (on) out.add(list.id)
  }
  for (const list of settings.customLists) if (list.enabled) out.add(list.id)
  return out
}

/** Is `listId` on because of the level (as opposed to a user override)? */
export function listDefaultFor(level: TrackingLevel, listId: string): boolean {
  const def = DEFAULT_FILTER_LISTS.find((l) => l.id === listId)
  return def ? level !== 'off' && levelIncludes(level, def.tier) : false
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i

export function normalizeSiteException(input: string): string | null {
  let host = input.trim().toLowerCase()
  if (!host) return null
  if (host.includes('://') || host.includes('/')) {
    try {
      host = new URL(host.includes('://') ? host : `https://${host}`).hostname
    } catch {
      return null
    }
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  return host === 'localhost' || DOMAIN_RE.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    ? host
    : null
}

export function sanitizeBlockingSettings(input: Partial<BlockingSettings> | undefined): BlockingSettings {
  const d = DEFAULT_BLOCKING_SETTINGS
  const s = input ?? {}
  const lists: Record<string, boolean> = {}
  if (s.lists && typeof s.lists === 'object')
    for (const [id, on] of Object.entries(s.lists)) if (typeof on === 'boolean') lists[id] = on
  const customLists: CustomFilterList[] = []
  const seenUrls = new Set<string>()
  if (Array.isArray(s.customLists))
    for (const item of s.customLists) {
      if (!item || typeof item !== 'object') continue
      const url = typeof item.url === 'string' ? item.url.trim() : ''
      if (!/^https?:\/\//i.test(url) || seenUrls.has(url)) continue
      seenUrls.add(url)
      customLists.push({
        id: typeof item.id === 'string' && item.id ? item.id : customListId(url),
        url,
        name: typeof item.name === 'string' && item.name ? item.name : url,
        enabled: item.enabled !== false
      })
    }
  const siteExceptions: string[] = []
  if (Array.isArray(s.siteExceptions))
    for (const raw of s.siteExceptions) {
      const host = typeof raw === 'string' ? normalizeSiteException(raw) : null
      if (host && !siteExceptions.includes(host)) siteExceptions.push(host)
    }
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    level: LEVELS.includes(s.level as TrackingLevel) ? (s.level as TrackingLevel) : d.level,
    lists,
    customLists,
    userFilters: typeof s.userFilters === 'string' ? s.userFilters.slice(0, 200_000) : '',
    siteExceptions,
    autoUpdate: typeof s.autoUpdate === 'boolean' ? s.autoUpdate : d.autoUpdate
  }
}

/** Stable id for a custom list: `custom-` plus a short hash of the URL. */
export function customListId(url: string): string {
  let h = 2166136261
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return `custom-${h.toString(16).padStart(8, '0')}`
}

// ---------------------------------------------------------------------------
// Status shown in the UI
// ---------------------------------------------------------------------------

export interface FilterListStatus {
  id: string
  name: string
  description: string
  url: string
  homepage: string
  licence: string
  /** Default lists carry their tier; custom lists have none. */
  tier: ListTier | null
  enabled: boolean
  /** `! Version:` from the list header, when present. */
  version: string | null
  /** When the current copy was fetched (or built into the app for the bundled snapshot). */
  updatedAt: number | null
  /** Network filters in the list (cosmetic rules are not counted). */
  filterCount: number
  /** The copy on disk is the snapshot bundled with this build. */
  bundled: boolean
  updating: boolean
  lastError: string | null
}

export interface BlockingStatus {
  /** The engine has loaded its rule sets and decides requests. */
  ready: boolean
  /** Requests blocked since the browser started. */
  sessionBlocked: number
  lists: FilterListStatus[]
  /** Any list is being fetched right now. */
  updating: boolean
  /** Most recent successful list refresh. */
  lastUpdatedAt: number | null
  /** Parse errors in the user's own filters (line numbers are 1-based). */
  userFilterErrors: Array<{ line: number; message: string }>
}

export function emptyBlockingStatus(): BlockingStatus {
  return {
    ready: false,
    sessionBlocked: 0,
    lists: [],
    updating: false,
    lastUpdatedAt: null,
    userFilterErrors: []
  }
}

/** Lists refresh once their copy is older than this (uBlock Origin's default expiry). */
export const FILTER_LIST_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000
