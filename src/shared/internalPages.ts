/**
 * Internal pages: browser UI that lives in a tab of its own – one route for every page the
 * browser itself provides, Settings today, the new tab page, History, Bookmarks and Downloads as
 * the desktop program moves them over. A page is a `zen://<page>[/<section>]` address – the
 * internal scheme every other `zen://` document already uses – and `zenium://` is its
 * user-facing alias: what the address bar shows, what deep links from outside the app carry
 * (`zenium://settings/privacy`), and what typed input accepts. `zenium://` never reaches
 * `tab.url`; it is normalised to `zen://` on the way in (`inputToUrl`, `openExternalUrl`) and
 * produced from it on the way out (`displayUrl`). Every navigation guard, error page and host
 * therefore keeps a single scheme.
 *
 * A page is drawn one of two ways ({@link InternalPageRender}): by the chrome inside the content
 * area, with no page view at all (Settings), or as a document the core serves into an ordinary
 * page view (the new tab page). The core's `PageService` opens, reuses and deep-links both the
 * same way; only what the tab holds differs.
 *
 * The section is the URL: `zen://settings` is the landing page, `zen://settings/look` the Look
 * and Feel section, so a restored session lands on the section it left. The tab's title, the
 * pill and the overview card all say "Settings" whatever the section ({@link internalPageTitle},
 * design language v2 §10.1); the section's own label is the drill-in header's.
 *
 * Pure data and parsing shared by the core (tab metadata, reuse, back) and the renderer (what to
 * draw). Every function takes the registry it reads as an optional last argument, defaulting to
 * {@link INTERNAL_PAGES}, so a page can be tried against the mechanism before it is registered.
 */
import type { FormFactor, HostCapabilities, OverlayKind } from './types'

/** The scheme `tab.url` carries for every internal document and page. */
export const INTERNAL_SCHEME = 'zen'
/** The user-facing alias: shown in the address bar, accepted from typed input and deep links. */
export const INTERNAL_ALIAS_SCHEME = 'zenium'

/** The pages registered today. Widened as pages move onto the mechanism. */
export type InternalPageId = 'settings'

/**
 * How a page's tab holds its page.
 *
 * `chrome`: the chrome draws the page inside the content area (React, the `InternalPageHost`);
 * the tab has no page view, fetches no favicon, records no history and is never snapshotted or
 * unloaded, and its history is the list of sections visited, kept by the core's `PageService`
 * and mirrored into `tab.canGoBack` / `canGoForward`. Needs `capabilities.pageTabs` (the chrome
 * must be able to draw into the content area); hosts without it open the page's `overlay`.
 *
 * `document`: the core serves the page as a document (`shared/zenPages.ts`: the new tab page,
 * the error page) into an ordinary page view, with the document's own history, favicon and
 * snapshot; loading, unloading and back are the view's, as for a site. Open, reuse, deep links
 * and typed addresses still go through the `PageService`, so both kinds are one route.
 */
export type InternalPageRender = 'chrome' | 'document'

/**
 * The glyph a page tab shows in its favicon slot – the pill, the sidebar row, the tab strip, the
 * overview card – named for the renderer to draw (Lucide's `settings`, `history`, `star`,
 * `download`); a page tab never fetches a favicon.
 */
export type InternalPageGlyph = 'settings' | 'history' | 'star' | 'download'

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
  /** The `zen://<id>` path segment; a registry key. */
  id: string
  /** The tab title on the landing page ("Settings"), and on every section for a chrome page. */
  title: string
  render: InternalPageRender
  /**
   * One tab of the page per window: a second open focuses the tab the window has and, given a
   * section, moves it there – Firefox's `switchToTabHavingURI` for about:preferences, Chrome's
   * one chrome://settings, chrome://history and chrome://downloads (v2 §10.1). `false`: every
   * open is a new tab (the new tab page).
   */
  singleton: boolean
  /** The favicon-slot glyph; absent for a page with no mark of its own (the new tab page). */
  glyph?: InternalPageGlyph
  /**
   * What the address pill shows for the page besides the glyph and its title. `showStar`: the
   * bookmark star chip stays, as Chrome keeps it on chrome://settings; the new tab page hides it.
   * A page never shows a lock, a site-information or a reader chip – there is no site.
   */
  pill: { showStar: boolean }
  /**
   * Whether the tab may share the content area in a split view. A chrome page fills the area
   * itself and is not splittable until the chrome can draw one page per pane; a document page
   * has a view of its own. The core reads this and nothing else, so a program flips it here.
   */
  splittable: boolean
  /**
   * A chrome page on a host without `capabilities.pageTabs` (the desktop, whose content frame the
   * chrome cannot draw into) opens as this overlay instead; a document page never needs one.
   */
  overlay?: OverlayKind
  /** The page's sections (`zen://<id>/<section>`); a page without sections has none. */
  sections: readonly InternalPageSection[]
}

/** A registry of pages by id: {@link INTERNAL_PAGES}, or one a test or a migration assembles. */
export type InternalPageRegistry = Readonly<Record<string, InternalPageDefinition>>

/**
 * Settings sections in nav order (Zen's `about:preferences` order, the desktop panel's): Zen's
 * own features first, Privacy and Security after Search as Firefox has it, then – past the
 * landing's first hairline (v2 §10.2) – the browser-wide categories, Sync, Accessibility,
 * Keyboard Shortcuts and Updates, whichever the host has, and About past the second. Ids are
 * stable: they are deep-link targets (`zenium://settings/privacy`) and what
 * `overlay.open { section }` callers already pass. Sections other PRs add (Downloads, Languages,
 * Passwords, Security) register here and drop into the landing list and the search in one line
 * each; the renderer maps ids to glyphs and content.
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
      'app icon',
      'sites',
      'desktop site'
    ]
  },
  {
    id: 'compact',
    label: 'Compact Mode',
    keywords: ['sidebar', 'toolbar', 'hide'],
    layouts: ['desktop', 'tablet']
  },
  {
    id: 'newtab',
    label: 'New Tab',
    keywords: ['new tab page', 'start page', 'shortcuts', 'most visited', 'background', 'greeting'],
    requires: 'newTabPage'
  },
  {
    id: 'tabs',
    label: 'Tab Management',
    keywords: ['tabs', 'pinned', 'essentials', 'unload', 'session', 'window']
  },
  {
    id: 'downloads',
    label: 'Downloads',
    keywords: ['save', 'folder', 'files', 'notification', 'open automatically']
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
    id: 'languages',
    label: 'Languages',
    keywords: [
      'languages',
      'translate',
      'translation',
      'offer to translate',
      'never translate',
      'preferred languages',
      'spell'
    ],
    requires: 'translate'
  },
  {
    id: 'privacy',
    label: 'Privacy and Security',
    keywords: ['ads', 'trackers', 'blocking', 'filter', 'permissions', 'site', 'exceptions'],
    requires: 'requestBlocking'
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
    id: 'passwords',
    label: 'Passwords',
    keywords: ['passwords', 'logins', 'vault', 'passphrase', 'checkup', 'generator'],
    requires: 'passwords'
  },
  {
    id: 'security',
    label: 'Security',
    keywords: [
      'security',
      'pop-ups',
      'popups',
      'certificates',
      'sign-in',
      'http authentication',
      'external apps',
      'protocols',
      'permissions'
    ]
  },
  {
    id: 'sync',
    label: 'Sync',
    keywords: ['devices', 'folder', 'passphrase'],
    requires: 'sync'
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    keywords: ['zoom', 'font size', 'text size', 'pinch'],
    requires: 'pageControls'
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

/**
 * The pages this build routes. Pages the desktop program registers as it moves them onto this
 * route (design entries, not implementations – `internal-page-tabs.md` §1): the new tab page is
 * `{ render: 'document', singleton: false, pill: { showStar: false }, splittable: true }` with no
 * glyph (its document is `zen://blank` today, `zen://newtab` an alias in `shared/url.ts`);
 * History, Bookmarks and Downloads are `singleton: true` with the `history`, `star` and
 * `download` glyphs, the star chip shown, and the render the desktop chooses for each (`chrome`
 * with an `overlay` where the chrome already draws them, or `document`). A page in the registry
 * is a page the parser routes, so nothing is registered ahead of its implementation.
 */
export const INTERNAL_PAGES: Readonly<Record<InternalPageId, InternalPageDefinition>> = {
  settings: {
    id: 'settings',
    title: 'Settings',
    render: 'chrome',
    singleton: true,
    glyph: 'settings',
    pill: { showStar: true },
    splittable: false,
    overlay: 'settings',
    sections: SETTINGS_SECTIONS
  }
}

/** Every registered page id. */
export const INTERNAL_PAGE_IDS: readonly InternalPageId[] = Object.keys(
  INTERNAL_PAGES
) as InternalPageId[]

/** A page and the section in it (`null` = the landing page). */
export interface InternalPageRef {
  id: string
  section: string | null
}

const PAGE_URL_RE = /^(zen|zenium):\/\/([a-z][a-z0-9-]*)(?:\/([a-z][a-z0-9-]*))?\/?(?:[?#].*)?$/i

/**
 * Parse `zen://settings`, `zen://settings/privacy` or their `zenium://` aliases into a page
 * reference; `null` for anything that is not a registered page (documents such as `zen://error`
 * included). Unknown sections resolve to the landing page rather than failing, so a stale deep
 * link still opens Settings. Sections a host lacks are the renderer's call
 * ({@link availableSections}); the parser is host neutral.
 */
export function parseInternalPageUrl(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): InternalPageRef | null {
  const m = PAGE_URL_RE.exec(url.trim())
  if (!m) return null
  const id = m[2].toLowerCase()
  const page = Object.prototype.hasOwnProperty.call(pages, id) ? pages[id] : undefined
  if (!page) return null
  const section = m[3]?.toLowerCase() ?? null
  const known = section !== null && page.sections.some((s) => s.id === section)
  return { id, section: known ? section : null }
}

/** The page a `zen://` / `zenium://` address names, if it is a registered one. */
export function internalPageOf(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): InternalPageDefinition | null {
  const ref = parseInternalPageUrl(url, pages)
  return ref ? pages[ref.id] : null
}

/** The canonical `zen://` address of a page reference (what `tab.url` carries). */
export function internalPageUrl(ref: InternalPageRef): string {
  return `${INTERNAL_SCHEME}://${ref.id}${ref.section ? `/${ref.section}` : ''}`
}

/** The user-facing `zenium://` form of a page address; other URLs come back unchanged. */
export function internalPageAliasUrl(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): string {
  const ref = parseInternalPageUrl(url, pages)
  return ref ? `${INTERNAL_ALIAS_SCHEME}://${ref.id}${ref.section ? `/${ref.section}` : ''}` : url
}

/** Whether the address is an internal page of either kind (as opposed to a document or a site). */
export function isInternalPageUrl(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): boolean {
  return parseInternalPageUrl(url, pages) !== null
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i

function schemeOf(url: string | null | undefined): string | null {
  const m = url ? SCHEME_RE.exec(url.trim()) : null
  return m ? m[1].toLowerCase() : null
}

/** Whether the address is under either internal scheme (a page or a document, known or not). */
export function namesInternal(url: string | null | undefined): boolean {
  const scheme = schemeOf(url)
  return scheme === INTERNAL_SCHEME || scheme === INTERNAL_ALIAS_SCHEME
}

/**
 * Whether a navigation the document at `document` started (a link, a script, a frame) to
 * `target` is refused: the target is an internal address and the document is not one of the
 * browser's own `zen://` documents. Internal pages are the user's to open – typed, from a menu,
 * shared in, sent by another app – and never a web page's, as Chrome refuses web content
 * `chrome://settings`. A web page, a `data:` or `about:blank` document, and a view with no
 * document yet are all refused; the browser's own documents (the error page, the new tab page)
 * may link to its pages. Every host reads this one rule for its renderer-initiated navigations
 * (`will-navigate` on desktop, `shouldOverrideUrlLoading` on Android, which mirrors it in
 * `DeepLinks.refusedFromDocument`); `planWindowOpen` refuses `window.open` the same way.
 */
export function refusedFromDocument(
  document: string | null | undefined,
  target: string | null | undefined
): boolean {
  if (!namesInternal(target)) return false
  return schemeOf(document) !== INTERNAL_SCHEME
}

/**
 * Whether the address is a page the chrome draws (`render: 'chrome'`): the tab has no page view,
 * so everything that would read one – loading, snapshots, favicons, the WebView's history – asks
 * this first. A document page answers false and is treated as any document.
 */
export function isChromePageUrl(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): boolean {
  return internalPageOf(url, pages)?.render === 'chrome'
}

/** The page's section definition, when the address names one. */
export function internalPageSection(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): InternalPageSection | null {
  const ref = parseInternalPageUrl(url, pages)
  if (!ref || !ref.section) return null
  return pages[ref.id].sections.find((s) => s.id === ref.section) ?? null
}

/**
 * What the tab, the pill and the overview card are called: the page's title ("Settings") on the
 * landing page and inside every section alike (v2 §10.1: the tab is "Settings"; the section's
 * label is the drill-in header's). `null` for URLs that are not internal pages. A document page
 * starts with this title and then reports its own, as any document does.
 */
export function internalPageTitle(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): string | null {
  return internalPageOf(url, pages)?.title ?? null
}

/** Two addresses are the same page when they name the same page id, whatever the section. */
export function sameInternalPage(
  a: string,
  b: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): boolean {
  const ra = parseInternalPageUrl(a, pages)
  const rb = parseInternalPageUrl(b, pages)
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

/** Sections a hairline precedes on the phone landing: Zen's two nav separators (v2 §10.2). */
export const SETTINGS_LANDING_BREAKS: readonly string[] = ['sync', 'about']

/**
 * The landing's category rows in runs a hairline separates: one break before Sync and one before
 * About, in the page's nav order. A break is a position in that order rather than a row, so a
 * host without Sync still separates what follows it (Updates) from Zen's features above, and a
 * run nothing falls into is dropped.
 */
export function landingRuns(
  page: InternalPageDefinition,
  sections: readonly InternalPageSection[],
  breaks: readonly string[] = SETTINGS_LANDING_BREAKS
): InternalPageSection[][] {
  const order = page.sections.map((s) => s.id)
  const thresholds = breaks
    .map((id) => order.indexOf(id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
  const runs: InternalPageSection[][] = thresholds.map(() => [])
  runs.push([])
  for (const section of sections) {
    const at = order.indexOf(section.id)
    const run = thresholds.filter((t) => at >= t).length
    runs[run].push(section)
  }
  return runs.filter((run) => run.length > 0)
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
