/**
 * Internal pages: browser UI that lives in a tab of its own (Settings today; the history page and
 * others can follow). A page is a `zen://<page>[/<section>]` address – the internal scheme every
 * other `zen://` document already uses – and `zenium://` is its user-facing alias: what the
 * address bar shows, what deep links from outside the app carry (`zenium://settings/privacy`),
 * and what typed input accepts. `zenium://` never reaches `tab.url`; it is normalised to `zen://`
 * on the way in (`inputToUrl`, `openExternalUrl`) and produced from it on the way out
 * (`displayUrl`). Every navigation guard, error page and host therefore keeps a single scheme.
 *
 * The section is the URL: `zen://settings` is the landing page, `zen://settings/look` the Look
 * and Feel section. The tab's title, the pill and the overview card all read off the URL through
 * {@link internalPageTitle}, so a restored session lands on the section it left.
 *
 * Pure data and parsing shared by the core (tab metadata, reuse, back) and the renderer (what to
 * draw). Nothing here knows how a page is rendered.
 */
import type { FormFactor, HostCapabilities } from './types'

/** The scheme `tab.url` carries for every internal document and page. */
export const INTERNAL_SCHEME = 'zen'
/** The user-facing alias: shown in the address bar, accepted from typed input and deep links. */
export const INTERNAL_ALIAS_SCHEME = 'zenium'

export type InternalPageId = 'settings'

/** One section of an internal page: `zen://<page>/<id>`. */
export interface InternalPageSection {
  id: string
  /** Title Case nav label ("Look and Feel", v2 §9.1); also the tab title inside the section. */
  label: string
  /** Terms the settings search matches besides the label (lower case). */
  keywords: readonly string[]
  /** Host capability the section needs; not listed where it is false. */
  requires?: keyof HostCapabilities
  /** Layouts the section applies to; absent means all of them. */
  layouts?: readonly FormFactor[]
}

export interface InternalPageDefinition {
  id: InternalPageId
  /** The tab title on the landing page ("Settings"). */
  title: string
  sections: readonly InternalPageSection[]
}

/**
 * Settings sections in nav order. Ids are stable: they are deep-link targets
 * (`zenium://settings/privacy`) and what `overlay.open { section }` callers already pass.
 * Sections other PRs add (Downloads, Languages, Passwords, Accessibility, Security) register
 * here and drop into the landing list, the header menulist and the search in one line each.
 */
export const SETTINGS_SECTIONS: readonly InternalPageSection[] = [
  {
    id: 'look',
    label: 'Look and Feel',
    keywords: [
      'appearance',
      'theme',
      'colour',
      'color',
      'dark',
      'light',
      'url bar',
      'navigation bar',
      'glance',
      'app icon'
    ]
  },
  {
    id: 'compact',
    label: 'Compact Mode',
    keywords: ['sidebar', 'toolbar', 'hide'],
    layouts: ['desktop', 'tablet']
  },
  {
    id: 'tabs',
    label: 'Tab Management',
    keywords: ['tabs', 'pinned', 'essentials', 'unload', 'session', 'downloads', 'window']
  },
  {
    id: 'privacy',
    label: 'Privacy and Security',
    keywords: ['ads', 'trackers', 'blocking', 'filter', 'permissions', 'site', 'exceptions']
  },
  {
    id: 'resources',
    label: 'Resources',
    keywords: ['memory', 'cpu', 'budget', 'freeze', 'process'],
    requires: 'resourceGovernor'
  },
  {
    id: 'search',
    label: 'Search',
    keywords: ['engine', 'suggestions', 'keyword']
  },
  {
    id: 'spaces',
    label: 'Space Routing',
    keywords: ['spaces', 'routes', 'domain']
  },
  {
    id: 'containers',
    label: 'Containers',
    keywords: ['cookies', 'accounts', 'isolate']
  },
  {
    id: 'boosts',
    label: 'Boosts',
    keywords: ['site', 'tint', 'font', 'zap', 'dark mode']
  },
  {
    id: 'mods',
    label: 'Mods',
    keywords: ['css', 'userchrome', 'style']
  },
  {
    id: 'extensions',
    label: 'Extensions',
    keywords: ['add-ons', 'addons', 'chrome web store'],
    requires: 'extensions'
  },
  {
    id: 'agents',
    label: 'AI Agents',
    keywords: ['mcp', 'ai', 'automation', 'token'],
    requires: 'agents'
  },
  {
    id: 'sync',
    label: 'Sync',
    keywords: ['devices', 'folder', 'passphrase'],
    requires: 'sync'
  },
  {
    id: 'shortcuts',
    label: 'Keyboard Shortcuts',
    keywords: ['keys', 'binding', 'hotkey'],
    layouts: ['desktop', 'tablet']
  },
  {
    id: 'updates',
    label: 'Updates',
    keywords: ['version', 'release', 'download', 'install'],
    requires: 'updates'
  },
  {
    id: 'about',
    label: 'About',
    keywords: ['version', 'default browser', 'engine', 'zen']
  }
]

export const INTERNAL_PAGES: Readonly<Record<InternalPageId, InternalPageDefinition>> = {
  settings: { id: 'settings', title: 'Settings', sections: SETTINGS_SECTIONS }
}

/** A page and the section in it (`null` = the landing page). */
export interface InternalPageRef {
  id: InternalPageId
  section: string | null
}

function isPageId(value: string): value is InternalPageId {
  return Object.prototype.hasOwnProperty.call(INTERNAL_PAGES, value)
}

const PAGE_URL_RE = /^(zen|zenium):\/\/([a-z][a-z0-9-]*)(?:\/([a-z][a-z0-9-]*))?\/?(?:[?#].*)?$/i

/**
 * Parse `zen://settings`, `zen://settings/privacy` or their `zenium://` aliases into a page
 * reference; `null` for anything that is not a registered page (documents such as `zen://error`
 * included). Unknown sections resolve to the landing page rather than failing, so a stale deep
 * link still opens Settings. Sections a host lacks are the renderer's call
 * ({@link availableSections}); the parser is host neutral.
 */
export function parseInternalPageUrl(url: string): InternalPageRef | null {
  const m = PAGE_URL_RE.exec(url.trim())
  if (!m) return null
  const id = m[2].toLowerCase()
  if (!isPageId(id)) return null
  const section = m[3]?.toLowerCase() ?? null
  const known = section !== null && INTERNAL_PAGES[id].sections.some((s) => s.id === section)
  return { id, section: known ? section : null }
}

/** The canonical `zen://` address of a page reference (what `tab.url` carries). */
export function internalPageUrl(ref: InternalPageRef): string {
  return `${INTERNAL_SCHEME}://${ref.id}${ref.section ? `/${ref.section}` : ''}`
}

/** The user-facing `zenium://` form of a page address; other URLs come back unchanged. */
export function internalPageAliasUrl(url: string): string {
  const ref = parseInternalPageUrl(url)
  return ref ? `${INTERNAL_ALIAS_SCHEME}://${ref.id}${ref.section ? `/${ref.section}` : ''}` : url
}

/** Whether the address is an internal page (as opposed to a document or a site). */
export function isInternalPageUrl(url: string): boolean {
  return parseInternalPageUrl(url) !== null
}

/** The page's section definition, when the address names one. */
export function internalPageSection(url: string): InternalPageSection | null {
  const ref = parseInternalPageUrl(url)
  if (!ref || !ref.section) return null
  return INTERNAL_PAGES[ref.id].sections.find((s) => s.id === ref.section) ?? null
}

/**
 * What the tab, the pill and the overview card are called: the page title on the landing page
 * ("Settings"), the section label inside a section ("Privacy and Security"). `null` for URLs that
 * are not internal pages.
 */
export function internalPageTitle(url: string): string | null {
  const ref = parseInternalPageUrl(url)
  if (!ref) return null
  const page = INTERNAL_PAGES[ref.id]
  return internalPageSection(url)?.label ?? page.title
}

/** Two addresses are the same page when they name the same page id, whatever the section. */
export function sameInternalPage(a: string, b: string): boolean {
  const ra = parseInternalPageUrl(a)
  const rb = parseInternalPageUrl(b)
  return ra !== null && rb !== null && ra.id === rb.id
}

/** The sections a host and layout can show, in nav order. */
export function availableSections(
  page: InternalPageDefinition,
  caps: HostCapabilities,
  formFactor: FormFactor
): InternalPageSection[] {
  return page.sections.filter(
    (s) => (!s.requires || caps[s.requires]) && (!s.layouts || s.layouts.includes(formFactor))
  )
}

/**
 * Filter sections by a search query: the label and keywords, any word order, case-insensitive.
 * An empty query returns every section. Row-level search inside a section is the renderer's
 * concern (each row registers its own text); this is the shared half both halves agree on.
 */
export function matchSections(
  sections: readonly InternalPageSection[],
  query: string
): InternalPageSection[] {
  const terms = normaliseQuery(query)
  if (terms.length === 0) return [...sections]
  return sections.filter((s) => {
    const haystack = [s.label, ...s.keywords].join(' ').toLowerCase()
    return terms.every((t) => haystack.includes(t))
  })
}

/** Whether a row's text (label, description, own keywords) matches every term of the query. */
export function matchesQuery(text: string, query: string): boolean {
  const terms = normaliseQuery(query)
  if (terms.length === 0) return true
  const haystack = text.toLowerCase()
  return terms.every((t) => haystack.includes(t))
}

function normaliseQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}
