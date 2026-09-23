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
import type { FormFactor, HostCapabilities, OverlayKind, Platform } from './types'

/** The scheme `tab.url` carries for every internal document and page. */
export const INTERNAL_SCHEME = 'zen'
/** The user-facing alias: shown in the address bar, accepted from typed input and deep links. */
export const INTERNAL_ALIAS_SCHEME = 'zenium'

/**
 * The pages registered today: Settings, History, Bookmarks and Downloads (chrome pages the
 * desktop and tablet layouts hold in a tab, the phone in its panels and sheets), the What's new
 * page (`zen://whats-new`, the running version's release notes, from Settings › About), the two
 * legal pages (`zen://privacy-notice`, `zen://terms`, from Settings › Legal), the print preview
 * (`zen://print`, a chrome page that is the desktop's print dialog) and the PDF viewer
 * (`zen://pdf?id=…`, a document page on hosts whose engine cannot draw a PDF). Widened as pages
 * move onto the mechanism.
 */
export type InternalPageId =
  | 'settings'
  | 'history'
  | 'bookmarks'
  | 'downloads'
  | 'whats-new'
  | 'privacy-notice'
  | 'terms'
  | 'print'
  | 'pdf'

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
 * `download`, `sparkles` for What's new, `file-text` for the legal pages); a page tab never
 * fetches a favicon.
 */
export type InternalPageGlyph =
  'settings' | 'history' | 'star' | 'download' | 'sparkles' | 'file-text'

/** One section of an internal page: `zen://<page>/<id>`. */
export interface InternalPageSection {
  id: string
  /** Title Case nav label ("Look and Feel", v2 §9.1); also the tab title inside the section. */
  label: string
  /** Terms the settings search matches besides the label (lower case). */
  keywords: readonly string[]
  /**
   * Host capability the section needs; not listed where it is false. A list names alternatives:
   * the section shows where any one of them is true (Accessibility: page controls or a speech
   * engine), its builder drawing the groups of those the host has.
   */
  requires?: keyof HostCapabilities | readonly (keyof HostCapabilities)[]
  /** Layouts the section applies to; absent means all of them. */
  layouts?: readonly FormFactor[]
  /**
   * Platforms the section exists on; absent means every one. Default Browser is a section on the
   * desktop OSes only (registration, status and the way to the system settings need the room);
   * Android keeps its one row under About, whatever the tablet's layout.
   */
  platforms?: readonly Platform[]
  /**
   * The section's own drill-in pages (v2 §10.2): a list a setting opens that can run long or
   * whose rows have their own actions – the sites that stored data – is a page of its own,
   * `zen://settings/<section>/<page>`, with the section beneath it in history (Chrome's All
   * sites). The phone shows it as a second drill-in; the two-pane layout keeps its dialog and
   * shows the section for the address.
   */
  pages?: readonly InternalPageSubpage[]
}

/** A drill-in page of a section's own (`InternalPageSection.pages`). */
export interface InternalPageSubpage {
  /** The third path segment; unique within its section. */
  id: string
  /** The drill-in header's title ("Site data"), sentence case as a row's title is. */
  label: string
}

/** Whether a host has what a section requires: the one capability, or any of the listed ones. */
export function sectionAvailable(section: InternalPageSection, caps: HostCapabilities): boolean {
  const { requires } = section
  if (requires === undefined) return true
  if (typeof requires === 'string') return caps[requires]
  return requires.some((cap) => caps[cap])
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
   * chrome cannot draw into) opens as this overlay instead, as it does on a layout its `layouts`
   * leave out; a document page never needs one.
   */
  overlay?: OverlayKind
  /**
   * Layouts in which a chrome page is a tab; absent means every one. On a layout left out the
   * page opens as its `overlay` although the host has page tabs: History, Bookmarks and
   * Downloads are the desktop's and the tablet's tabs (v2 §10.1), while the phone keeps its
   * panels and sheets for them – lists a finger reads and swipes differently. Read through
   * {@link pageOpensAsTab}.
   */
  layouts?: readonly FormFactor[]
  /**
   * Host capability the page needs (the print preview needs `printPreview`): the `PageService`
   * refuses to open the page on a host without it, and a typed address loads as a plain
   * document. The parser stays host neutral, as for sections.
   */
  requires?: keyof HostCapabilities
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
      'split view',
      'app icon',
      'sites',
      'desktop site'
    ]
  },
  {
    id: 'compact',
    label: 'Compact Mode',
    keywords: ['sidebar', 'toolbar', 'hide'],
    // The desktop's hover-revealed sidebar; the tablet collapses its sidebar to the icon rail
    // from its toolbar instead (TABLET-02) and the phone has no sidebar.
    layouts: ['desktop']
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
    id: 'autofill',
    label: 'Autofill',
    keywords: [
      'autofill',
      'addresses',
      'payment methods',
      'cards',
      'passkeys',
      'save passwords',
      'offer to save',
      'clipboard'
    ],
    requires: 'passwords'
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
    requires: 'translate',
    // Add language: Chrome's 160-language picker as the phone's find-and-pick page – a set the
    // user finds in rather than scans (§9.13, §10.2); `?list=` names which of the section's
    // lists the pick joins (preferred, always, never).
    pages: [{ id: 'add', label: 'Add language' }]
  },
  {
    id: 'privacy',
    label: 'Privacy and Security',
    keywords: [
      'ads',
      'trackers',
      'blocking',
      'filter',
      'permissions',
      'site',
      'exceptions',
      'safe browsing',
      'https',
      'dns',
      'cookies',
      'do not track'
    ],
    requires: 'requestBlocking',
    // See all site data and permissions: the sites that stored cookies or data, Chrome's All
    // sites – a list that can run to a thousand rows, each with its own action (§10.2).
    pages: [{ id: 'site-data', label: 'Site data' }]
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
      'permissions',
      'notifications'
    ]
  },
  {
    id: 'sync',
    label: 'Sync',
    keywords: ['devices', 'folder', 'passphrase', 'sync now', 'encrypted'],
    requires: 'sync'
  },
  {
    // Chrome's "Import bookmarks and settings" (ID-23): another browser's profile on a desktop,
    // a bookmarks HTML or passwords CSV file on every host.
    id: 'import',
    label: 'Import',
    keywords: [
      'import',
      'chrome',
      'edge',
      'firefox',
      'safari',
      'other browser',
      'bookmarks',
      'history',
      'passwords',
      'html',
      'csv',
      'transfer',
      'migrate'
    ]
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    keywords: [
      'zoom',
      'font size',
      'text size',
      'pinch',
      'read aloud',
      'listen',
      'voice',
      'speech'
    ],
    requires: ['pageControls', 'readAloud']
  },
  {
    id: 'shortcuts',
    label: 'Keyboard Shortcuts',
    keywords: ['keys', 'binding', 'hotkey'],
    layouts: ['desktop', 'tablet']
  },
  {
    id: 'default-browser',
    label: 'Default Browser',
    keywords: ['default', 'links', 'open with', 'system', 'register'],
    requires: 'defaultBrowser',
    platforms: ['win32', 'darwin', 'linux']
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
    keywords: [
      'version',
      'default browser',
      'engine',
      'zen',
      "what's new",
      'release notes',
      'legal',
      'notice',
      'terms'
    ]
  }
]

/** The layouts whose chrome holds History, Bookmarks and Downloads in a tab (the phone keeps its panels). */
const TAB_LAYOUTS: readonly FormFactor[] = ['desktop', 'tablet']

/**
 * The pages this build routes. Pages the desktop program registers as it moves them onto this
 * route (design entries, not implementations – `internal-page-tabs.md` §1): the new tab page is
 * `{ render: 'document', singleton: false, pill: { showStar: false }, splittable: true }` with no
 * glyph (its document is `zen://blank` today, `zen://newtab` an alias in `shared/url.ts`). A page
 * in the registry is a page the parser routes, so nothing is registered ahead of its
 * implementation.
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
  },
  /**
   * History (`zen://history`, Chrome's one chrome://history): the day groups are one scroll,
   * not sections; `?q=<text>` pre-fills its search (`chrome://history/?q=`, what "More from This
   * Site" and `@history <text>` open it with). A page on the desktop and the tablet; the phone's
   * panel stays its overlay. No star chip: a page of the browser's own is nothing to bookmark.
   */
  history: {
    id: 'history',
    title: 'History',
    render: 'chrome',
    singleton: true,
    glyph: 'history',
    pill: { showStar: false },
    splittable: false,
    overlay: 'history',
    layouts: TAB_LAYOUTS,
    sections: []
  },
  /**
   * The bookmarks manager (`zen://bookmarks`, chrome://bookmarks): the folder tree is in the
   * page, not sections; `?folder=<id>` opens on a folder (the bar's "Bookmark Manager", the
   * import dialog's "Show in Bookmarks"), `?q=<text>` pre-fills its search (`@bookmarks <text>`).
   */
  bookmarks: {
    id: 'bookmarks',
    title: 'Bookmarks',
    render: 'chrome',
    singleton: true,
    glyph: 'star',
    pill: { showStar: false },
    splittable: false,
    overlay: 'bookmarks',
    layouts: TAB_LAYOUTS,
    sections: []
  },
  /** Downloads (`zen://downloads`, chrome://downloads): the day groups as one scroll, no sections. */
  downloads: {
    id: 'downloads',
    title: 'Downloads',
    render: 'chrome',
    singleton: true,
    glyph: 'download',
    pill: { showStar: false },
    splittable: false,
    overlay: 'downloads',
    layouts: TAB_LAYOUTS,
    sections: []
  },
  /**
   * What's new (`zen://whats-new`, SET-54; Chrome's What's new tab): the running version's
   * release notes as the updater's check brought them (`UpdateStatus.notes`), from Settings ›
   * About. A chrome page tab on every layout with page tabs, no panel form; one scroll of prose,
   * no sections.
   */
  'whats-new': {
    id: 'whats-new',
    title: 'What’s new',
    render: 'chrome',
    singleton: true,
    glyph: 'sparkles',
    pill: { showStar: false },
    splittable: false,
    sections: []
  },
  /**
   * The legal pages (SET-55; Chrome's Privacy notice and Terms of service rows under About):
   * `zen://privacy-notice` and `zen://terms`, from Settings › Legal. Chrome page tabs on every
   * layout with page tabs, prose alone, no sections.
   */
  'privacy-notice': {
    id: 'privacy-notice',
    title: 'Privacy notice',
    render: 'chrome',
    singleton: true,
    glyph: 'file-text',
    pill: { showStar: false },
    splittable: false,
    sections: []
  },
  terms: {
    id: 'terms',
    title: 'Terms',
    render: 'chrome',
    singleton: true,
    glyph: 'file-text',
    pill: { showStar: false },
    splittable: false,
    sections: []
  },
  /**
   * The print preview (`shared/print.ts`, `core/print.ts`): Chrome's `chrome://print`, a
   * tab-modal dialog over the page it prints, so on the desktop – the host with the preview,
   * and one without page tabs – it opens as the `print` overlay for the active tab. Never a tab
   * of its own: one preview per tab, no sections, no star.
   */
  print: {
    id: 'print',
    title: 'Print',
    render: 'chrome',
    singleton: true,
    pill: { showStar: false },
    splittable: false,
    overlay: 'print',
    requires: 'printPreview',
    sections: []
  },
  /**
   * The PDF viewer (`shared/pdfPage.ts`): `zen://pdf?id=<download>` shows a PDF the host
   * downloaded, in the tab that navigated to it, as Chrome Android's inline viewer does. A
   * document page: an ordinary page view with the viewer's own history, a title from the file's
   * name, and every open its own (two PDFs are two tabs).
   */
  pdf: {
    id: 'pdf',
    title: 'PDF',
    render: 'document',
    singleton: false,
    pill: { showStar: true },
    splittable: true,
    requires: 'pdfViewer',
    sections: []
  }
}

/** Every registered page id. */
export const INTERNAL_PAGE_IDS: readonly InternalPageId[] = Object.keys(
  INTERNAL_PAGES
) as InternalPageId[]

/**
 * A page's own parameters, carried as the address's query (`zen://history?q=example.com`,
 * `zen://bookmarks?folder=<id>`, `zen://settings/privacy?site=<origin>`): what the page opens on
 * besides its section – a filter, a folder, a site – as Chrome's `chrome://history/?q=`,
 * `chrome://bookmarks/?id=` and `chrome://settings/content/siteDetails?site=` carry theirs.
 * Never a section, and never in the alias the pill shows ({@link internalPageAliasUrl}).
 */
export type InternalPageQuery = Readonly<Record<string, string>>

/**
 * A page and the section in it (`null` = the landing page), the section's drill-in page when
 * the address names one (`zen://settings/privacy/site-data`, {@link InternalPageSubpage}), and
 * the page's query when it has one.
 */
export interface InternalPageRef {
  id: string
  section: string | null
  /** A drill-in page of the section (`InternalPageSection.pages`); absent for the section itself. */
  subpage?: string
  query?: InternalPageQuery
}

const PAGE_URL_RE =
  /^(zen|zenium):\/\/([a-z][a-z0-9-]*)(?:\/([a-z][a-z0-9-]*)(?:\/([a-z][a-z0-9-]*))?)?\/?(?:\?([^#]*))?(?:#.*)?$/i

/**
 * Parse `zen://settings`, `zen://settings/privacy`, `zen://settings/privacy/site-data` or their
 * `zenium://` aliases into a page reference; `null` for anything that is not a registered page
 * (documents such as `zen://error` included). Unknown sections resolve to the landing page
 * rather than failing, so a stale deep link still opens Settings; an unknown drill-in page
 * resolves to its section the same way. Sections a host lacks are the renderer's call
 * ({@link availableSections}); the parser is host neutral. A query comes back as the page's
 * parameters ({@link InternalPageQuery}); an address without one has none.
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
  const sectionId = m[3]?.toLowerCase() ?? null
  const section = sectionId !== null ? page.sections.find((s) => s.id === sectionId) : undefined
  const subpage = m[4]?.toLowerCase()
  const known = subpage !== undefined && section?.pages?.some((p) => p.id === subpage)
  const query = m[5] ? Object.fromEntries(new URLSearchParams(m[5])) : {}
  const ref: InternalPageRef = { id, section: section ? section.id : null }
  if (known) ref.subpage = subpage
  if (Object.keys(query).length > 0) ref.query = query
  return ref
}

/**
 * Whether a page is a tab on this host and layout: a document page always; a chrome page where
 * the chrome can draw into the content area (`capabilities.pageTabs`) and the layout is one of
 * the page's `layouts` (every layout when it names none). Anywhere else a chrome page opens as
 * its `overlay`. The core's `PageService` and the chrome's `overlayAvailable` read this one rule,
 * so both halves agree on which presentation an ask gets.
 */
export function pageOpensAsTab(
  page: InternalPageDefinition,
  caps: Pick<HostCapabilities, 'pageTabs'>,
  formFactor: FormFactor
): boolean {
  if (page.render !== 'chrome') return true
  if (!caps.pageTabs) return false
  return !page.layouts || page.layouts.includes(formFactor)
}

/**
 * The overlay kinds that were Settings sections before Settings was a tab (`shortcuts`, `sync`),
 * and open that section of the page. Not every kind that shares a section's id: `boosts` and
 * `passwords` are panels of their own beside their Settings categories.
 */
const SETTINGS_SECTION_OVERLAYS: readonly OverlayKind[] = ['shortcuts', 'sync']

/**
 * The page an overlay kind stands for, when it is a page's overlay: the page whose `overlay` it
 * is (`history` → History), or the Settings section the kind used to retarget
 * ({@link SETTINGS_SECTION_OVERLAYS}). `null` for a kind that is an overlay in its own right
 * (the theme picker, the space editor, the Boosts panel). What a request for the overlay opens
 * instead where the page is a tab.
 */
export function pageForOverlayKind(
  kind: OverlayKind,
  pages: InternalPageRegistry = INTERNAL_PAGES
): InternalPageRef | null {
  const page = Object.values(pages).find((p) => p.overlay === kind)
  if (page) return { id: page.id, section: null }
  const settings = Object.prototype.hasOwnProperty.call(pages, 'settings')
    ? pages.settings
    : undefined
  if (settings && SETTINGS_SECTION_OVERLAYS.includes(kind))
    return { id: settings.id, section: kind }
  return null
}

/** The page a `zen://` / `zenium://` address names, if it is a registered one. */
export function internalPageOf(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): InternalPageDefinition | null {
  const ref = parseInternalPageUrl(url, pages)
  return ref ? pages[ref.id] : null
}

/** The page, its section and the section's drill-in page as path segments (`settings/privacy/site-data`). */
function pagePath(ref: InternalPageRef): string {
  if (!ref.section) return ref.id
  return `${ref.id}/${ref.section}${ref.subpage ? `/${ref.subpage}` : ''}`
}

/** The canonical `zen://` address of a page reference (what `tab.url` carries), query included. */
export function internalPageUrl(ref: InternalPageRef): string {
  const query = ref.query && Object.keys(ref.query).length > 0 ? ref.query : null
  return `${INTERNAL_SCHEME}://${pagePath(ref)}${
    query ? `?${new URLSearchParams(query).toString()}` : ''
  }`
}

/**
 * The user-facing `zenium://` form of a page address – the page, its section and the section's
 * drill-in page, never its query (the pill says `zenium://history`, as `zenium://pdf` says
 * nothing of the file's id); other URLs come back unchanged.
 */
export function internalPageAliasUrl(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): string {
  const ref = parseInternalPageUrl(url, pages)
  return ref ? `${INTERNAL_ALIAS_SCHEME}://${pagePath(ref)}` : url
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

/** The section's drill-in page the address names (`zen://settings/privacy/site-data`), else null. */
export function internalPageSubpage(
  url: string,
  pages: InternalPageRegistry = INTERNAL_PAGES
): InternalPageSubpage | null {
  const ref = parseInternalPageUrl(url, pages)
  if (!ref?.subpage) return null
  const section = internalPageSection(url, pages)
  return section?.pages?.find((p) => p.id === ref.subpage) ?? null
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

/**
 * The sections a host and layout can show, in nav order. A section listing `platforms` shows
 * on those alone; a caller that names no platform gets none of them.
 */
export function availableSections(
  page: InternalPageDefinition,
  caps: HostCapabilities,
  formFactor: FormFactor,
  platform?: Platform
): InternalPageSection[] {
  return page.sections.filter(
    (s) =>
      sectionAvailable(s, caps) &&
      (!s.layouts || s.layouts.includes(formFactor)) &&
      (!s.platforms || (platform !== undefined && s.platforms.includes(platform)))
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
