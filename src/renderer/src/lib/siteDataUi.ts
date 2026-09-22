import type { BrowsingDataType } from '@shared/types'
import {
  CLEAR_ON_EXIT_TYPES,
  SITE_DATA_DEFAULT_LABELS,
  SITE_DATA_ORIGIN_CAP,
  siteDataListLabel,
  type ClearOnExitType,
  type SiteDataDefault,
  type SiteDataList,
  type SiteDataListing,
  type SiteDataOriginRow,
  type SiteDataSiteState,
  type SiteDataState,
  type SiteDataStatus
} from '@shared/siteData'
import { normalizeSitePattern } from '@shared/sitePatterns'
import { formatBytes } from '@shared/siteInfo'
import { cmd } from './api'
import { TYPE_LABEL } from './browsingData'

/**
 * The words of Cookies and site data (`pages/settings/siteDataRows.tsx`, `SiteDataViewer.tsx`,
 * the site-information sheet's and popover's cookies level): the default's choice, the three
 * lists, the on-exit types, the viewer's lines and the per-site row, kept apart from the
 * rendering so the two platforms say the same thing and the tests can read it on its own.
 * Chrome's wording where the matrix names it (`chrome://settings/cookies`); Edge's for the
 * on-exit heading, which Chrome has no page for.
 */

export const SITE_DATA_TEXT = {
  heading: 'Cookies and site data',
  description:
    'What sites may keep on this device. The default applies to every site on no list; the lists below are the exceptions.',
  default: {
    label: 'Default behaviour',
    sheetDescription: 'What a site on none of the lists below may do with cookies.'
  },
  lists: {
    empty: 'No sites added',
    add: 'Add a site',
    addButton: 'Add…',
    addDescription: 'A site, or [*.]site for its subdomains too',
    field: 'Site',
    fieldHint:
      'example.com covers that host; [*.]example.com its subdomains too. https:// or :8443 narrows it.',
    placeholder: '[*.]example.com',
    invalid: 'Enter a site such as example.com or [*.]example.com',
    duplicate: 'That site is already on this list',
    moves: (from: string) => `Currently under “${from}”; adding moves it here`,
    remove: 'Remove from the list',
    removeButton: 'Remove'
  },
  clearOnExit: {
    heading: 'Delete browsing data on exit',
    description:
      'Choose what to clear every time you close Zenium. Saved passwords are never cleared this way.',
    nextLaunch: 'On this device the clearing runs the next time Zenium starts.',
    lists: 'The sites on the clear-on-exit and never lists are cleared whatever you choose here.',
    pending: 'A clear owed from the last close is still running.'
  },
  viewer: {
    open: 'See all site data and permissions',
    openDescription: 'Every site with cookies, stored data or permissions, the most data first',
    title: 'Site data',
    description:
      'Sites that stored cookies or data on this device, or hold a permission. Clearing a site signs you out of it; its permissions stay.',
    sites: 'Sites',
    reading: 'Reading…',
    empty: 'No site has stored anything yet',
    sizeUnavailable: 'Sizes are unavailable on this device.',
    clear: 'Clear',
    clearAll: 'Clear all',
    clearAllTitle: 'Clear all site data?',
    clearAllDescription:
      'Removes every site’s cookies and stored data, from every container, and signs you out everywhere. Permissions stay.',
    cleared: (site: string) => `Cleared ${site}`,
    clearedAll: 'Cleared every site’s cookies and data',
    failed: 'That did not work. Try again.'
  },
  site: {
    label: 'Cookies for this site',
    picker: 'Cookies for this site',
    noSite: 'This page has no site to add',
    // Chrome's site-details words ("Clear on exit"), which also fit the desktop popover's
    // menulist trailing the row; the description under each says when the clear runs.
    options: {
      default: 'Use the default',
      allow: 'Always allow',
      clearOnExit: 'Clear on exit',
      block: 'Never allow'
    },
    optionDescriptions: {
      allow: 'The site can always use cookies, embedded in other sites too.',
      clearOnExit: 'Its cookies and data go when Zenium closes.',
      clearOnExitNextLaunch: 'Its cookies and data go the next time Zenium starts.',
      block: 'No cookies; what it stored is cleared now.'
    }
  }
} as const

// ---------------------------------------------------------------------------
// The default
// ---------------------------------------------------------------------------

export const SITE_DATA_DEFAULTS: readonly SiteDataDefault[] = [
  'allow',
  'block-third-party',
  'block-all'
]

/** The default's three options (§9.13 radio rows), Chrome's radios with the one Zenium keeps. */
export function siteDataDefaultOptions(): Array<{
  value: SiteDataDefault
  label: string
  description: string
}> {
  return SITE_DATA_DEFAULTS.map((value) => ({ value, ...SITE_DATA_DEFAULT_LABELS[value] }))
}

// ---------------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------------

export const SITE_DATA_LIST_ORDER: readonly SiteDataList[] = ['allow', 'clearOnExit', 'block']

/** The list's heading: Chrome's, with the close a host without windows has. */
export function siteDataListHeading(list: SiteDataList, windows: boolean): string {
  return siteDataListLabel(list, windows)
}

/** The group's introductory line under each list's heading. */
export function siteDataListDescription(list: SiteDataList, nextLaunch: boolean): string {
  switch (list) {
    case 'allow':
      return 'These sites can use cookies whatever the default says, embedded in other sites too.'
    case 'clearOnExit':
      return nextLaunch
        ? 'These sites keep their cookies for the session; the cookies and stored data go the next time Zenium starts.'
        : 'These sites keep their cookies for the session; the cookies and stored data go when Zenium closes.'
    case 'block':
      return 'These sites can never use cookies. What a site stored is cleared when it is added.'
  }
}

/** The second line of a pattern's row: what its list does for it. */
export function siteDataPatternDescription(list: SiteDataList, nextLaunch: boolean): string {
  switch (list) {
    case 'allow':
      return 'Can always use cookies'
    case 'clearOnExit':
      return nextLaunch ? 'Cleared the next time Zenium starts' : 'Cleared when Zenium closes'
    case 'block':
      return 'Can never use cookies'
  }
}

/** Which list holds the pattern (as typed), or null. */
export function siteDataListOf(status: SiteDataStatus, pattern: string): SiteDataList | null {
  const canonical = normalizeSitePattern(pattern)
  if (!canonical) return null
  for (const list of SITE_DATA_LIST_ORDER) if (status[list].includes(canonical)) return list
  return null
}

/**
 * What the add form says under its field for the value typed so far: the hint while the field
 * is empty or the pattern is new, the refusal for text that is not a pattern, the duplicate
 * line for a pattern already on this list, and the note that a pattern on another list moves.
 */
export function siteDataAddFeedback(
  status: SiteDataStatus,
  list: SiteDataList,
  value: string,
  windows: boolean
): { problem: string | null; hint: string } {
  const text = value.trim()
  if (text === '') return { problem: null, hint: SITE_DATA_TEXT.lists.fieldHint }
  const canonical = normalizeSitePattern(text)
  if (!canonical) return { problem: SITE_DATA_TEXT.lists.invalid, hint: '' }
  const holder = siteDataListOf(status, canonical)
  if (holder === list) return { problem: SITE_DATA_TEXT.lists.duplicate, hint: '' }
  if (holder)
    return { problem: null, hint: SITE_DATA_TEXT.lists.moves(siteDataListHeading(holder, windows)) }
  return { problem: null, hint: SITE_DATA_TEXT.lists.fieldHint }
}

// ---------------------------------------------------------------------------
// Clear on exit
// ---------------------------------------------------------------------------

/** The on-exit types in the dialog's order, with the dialog's labels; passwords are never one. */
export function clearOnExitRows(): Array<{ type: ClearOnExitType; label: string }> {
  return CLEAR_ON_EXIT_TYPES.map((type) => ({ type, label: TYPE_LABEL[type as BrowsingDataType] }))
}

/** The on-exit group's paragraph: the choice, the host's timing, the lists' standing clear. */
export function clearOnExitDescription(status: SiteDataStatus): string {
  const parts: string[] = [SITE_DATA_TEXT.clearOnExit.description]
  if (status.clearsAtNextLaunch) parts.push(SITE_DATA_TEXT.clearOnExit.nextLaunch)
  if (status.clearOnExit.length > 0 || status.block.length > 0)
    parts.push(SITE_DATA_TEXT.clearOnExit.lists)
  if (status.pendingClear) parts.push(SITE_DATA_TEXT.clearOnExit.pending)
  return parts.join(' ')
}

/** The types with one turned on or off, in the dialog's order. */
export function toggleClearOnExitType(
  types: readonly ClearOnExitType[],
  type: ClearOnExitType,
  on: boolean
): ClearOnExitType[] {
  const next = new Set(types)
  if (on) next.add(type)
  else next.delete(type)
  return CLEAR_ON_EXIT_TYPES.filter((t) => next.has(t))
}

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

/** An origin as the viewer names it: the host (and port) of an https origin, the whole of another. */
export function originLabel(origin: string): string {
  return origin.replace(/^https:\/\//, '')
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * The storage line under an origin: its cookies and its size where the host sized it, the
 * permissions it holds; "Permissions only" for a row with nothing stored. An unsized origin on a
 * host that sizes others says so; where no origin is sized (Electron) the header says it once.
 */
export function originLine(row: SiteDataOriginRow, sized: boolean): string {
  const parts: string[] = []
  if (row.cookies > 0) parts.push(plural(row.cookies, 'cookie'))
  if (row.usageBytes !== null && row.usageBytes > 0) parts.push(formatBytes(row.usageBytes))
  else if (sized && row.usageBytes === null && row.cookies === 0) parts.push('Size unavailable')
  if (row.permissions.length > 0) parts.push(plural(row.permissions.length, 'permission'))
  if (parts.length === 0) return 'No data'
  return parts.join(' · ')
}

/** The state's word for a row's trailing (nothing for the default). */
export function siteDataStateWord(state: SiteDataState): string | null {
  switch (state) {
    case 'allow':
      return 'Always allowed'
    case 'block':
      return 'Never allowed'
    case 'clear-on-exit':
      return 'Cleared on exit'
    case 'default':
      return null
  }
}

/**
 * The count at the list heading's gutter (§10.3's aside): how many sites, or how many of them
 * the rows hold when the listing stopped at the cap.
 */
export function siteDataCountAside(listing: SiteDataListing): string {
  if (listing.truncated)
    return `${SITE_DATA_ORIGIN_CAP.toLocaleString()} of ${plural(listing.total, 'site')}`
  return plural(listing.total, 'site')
}

/**
 * The line under the list heading, when there is something to say: the cap's count line when
 * the listing stopped at it, and the one "sizes unavailable" note where no origin could be sized
 * (Electron) – said once here, never per row.
 */
export function siteDataListingNote(listing: SiteDataListing): string | undefined {
  const parts: string[] = []
  if (listing.truncated)
    parts.push(
      `Showing the ${SITE_DATA_ORIGIN_CAP.toLocaleString()} sites with the most data of ${listing.total.toLocaleString()}.`
    )
  if (!listing.sized && listing.rows.length > 0) parts.push(SITE_DATA_TEXT.viewer.sizeUnavailable)
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** The row's second line: the storage line, then the policy's word for the origin when a list holds it. */
export function originDescription(row: SiteDataOriginRow, sized: boolean): string {
  const state = siteDataStateWord(row.state)
  const line = originLine(row, sized)
  return state ? `${line} · ${state}` : line
}

// ---------------------------------------------------------------------------
// The site-information sheet's row
// ---------------------------------------------------------------------------

export type SiteDataChoice = 'default' | SiteDataList

const CHOICE_OF_STATE: Record<SiteDataState, SiteDataChoice> = {
  default: 'default',
  allow: 'allow',
  'clear-on-exit': 'clearOnExit',
  block: 'block'
}

/** The picker's current option for the page's state. */
export function siteDataChoice(site: SiteDataSiteState): SiteDataChoice {
  return CHOICE_OF_STATE[site.state]
}

/** The picker's current option by name (the phone row's second line starts with it). */
export function siteDataChoiceLabel(site: SiteDataSiteState): string {
  return SITE_DATA_TEXT.site.options[siteDataChoice(site)]
}

/**
 * What decides for the page, beside the choice's name: the entry on the list (`[*.]example.com`,
 * as it stands), or – under "Use the default" – the default it falls to, so the row says what
 * that default is. A page with no site to add says so.
 */
export function siteDataDecider(site: SiteDataSiteState): string {
  if (site.pattern) return `Listed as ${site.pattern}`
  if (!site.addable) return SITE_DATA_TEXT.site.noSite
  return SITE_DATA_DEFAULT_LABELS[site.default].label
}

/** The phone row's second line (§9.2): the choice, then what decides – as the Settings value row names its option. */
export function siteDataRowLine(site: SiteDataSiteState): string {
  return `${siteDataChoiceLabel(site)} · ${siteDataDecider(site)}`
}

/**
 * The overview row's second line, when a list decides for the page: the state's word under
 * "Cookies and site data", the storage summary keeping the trailing. Nothing for the default.
 */
export function siteDataOverviewLine(site: SiteDataSiteState): string | undefined {
  return siteDataStateWord(site.state) ?? undefined
}

/**
 * What picking a choice in the site-information sheet does: the page's site (`[*.]host`) goes
 * onto the list picked, leaving whichever list held it; "Use the default" takes the deciding
 * entry off its list – the entry as it stands, `[*.]example.com` for a page on a subdomain too,
 * which is what the row named. Resolves to the reason when the engine refused (a page with no
 * site, a list holding its thousand), null when it did as asked; the reading is the caller's to
 * refresh.
 */
export async function applySiteDataChoice(
  site: SiteDataSiteState,
  url: string,
  choice: SiteDataChoice
): Promise<string | null> {
  if (choice === 'default') {
    if (site.pattern) await cmd('siteData.remove', { pattern: site.pattern })
    return null
  }
  const result = await cmd('siteData.addSite', { list: choice, url })
  return result.ok ? null : result.problem
}

/** The picker's four options: the default named for what it is, then the three lists. */
export function siteDataChoiceOptions(
  site: SiteDataSiteState,
  nextLaunch: boolean
): Array<{ value: SiteDataChoice; label: string; description: string }> {
  const t = SITE_DATA_TEXT.site
  return [
    {
      value: 'default',
      label: t.options.default,
      description: SITE_DATA_DEFAULT_LABELS[site.default].label
    },
    { value: 'allow', label: t.options.allow, description: t.optionDescriptions.allow },
    {
      value: 'clearOnExit',
      label: t.options.clearOnExit,
      description: nextLaunch
        ? t.optionDescriptions.clearOnExitNextLaunch
        : t.optionDescriptions.clearOnExit
    },
    { value: 'block', label: t.options.block, description: t.optionDescriptions.block }
  ]
}
