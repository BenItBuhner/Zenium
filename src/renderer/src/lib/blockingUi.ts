import type { Tab } from '@shared/types'
import {
  listDefaultFor,
  siteOriginOf,
  type BlockingSettings,
  type BlockingStatus,
  type FilterListStatus
} from '@shared/blocking'

/**
 * What the chrome says about blocking: the URL-bar chip and the status card of
 * Settings > Privacy and security. Pure functions over core state so the wording is testable
 * without rendering.
 */

const count = new Intl.NumberFormat()

/**
 * A `relativeTime` value inside a sentence: it comes capitalised for standing alone ("Just now")
 * and sentence case (§9.1) wants "Lists updated just now".
 */
function inSentence(when: string): string {
  return when.charAt(0).toLowerCase() + when.slice(1)
}

/** `count` requests, spelt out. */
export function requests(n: number): string {
  return `${count.format(n)} ${n === 1 ? 'request' : 'requests'}`
}

/** How blocking stands on the page in `tab`. */
export type SiteBlockingState =
  /** The tab shows no web page (a zen:// page, a blank tab). */
  | 'no-site'
  /** The master switch is off or the level is Off: nothing is blocked anywhere. */
  | 'off'
  /** The site is excepted: nothing is blocked here. */
  | 'excepted'
  /** The engine blocks on this page. */
  | 'blocking'

export function siteBlockingState(
  tab: Tab | null,
  status: Pick<BlockingStatus, 'enabled' | 'siteExceptions'>,
  settings: Pick<BlockingSettings, 'level'>
): SiteBlockingState {
  const origin = tab ? siteOriginOf(tab.url) : null
  if (!origin) return 'no-site'
  if (!status.enabled || settings.level === 'off') return 'off'
  if (status.siteExceptions.includes(origin)) return 'excepted'
  return 'blocking'
}

/** Tooltip and accessible name of the URL-bar chip. */
export function blockedChipLabel(state: SiteBlockingState, blocked: number): string {
  switch (state) {
    case 'blocking':
      return blocked === 0
        ? 'Nothing blocked on this page yet · Site information'
        : `${requests(blocked)} blocked on this page · Site information`
    case 'excepted':
      return 'Blocking is off for this site · Site information'
    case 'off':
      return 'Ad and tracker blocking is off · Site information'
    case 'no-site':
      return 'Site information'
  }
}

/** The count the chip shows: compact past 999 so the pill never widens the URL bar. */
export function chipCount(blocked: number): string {
  if (blocked < 1000) return String(blocked)
  if (blocked < 10_000) return `${(blocked / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(blocked / 1000)}k`
}

export interface StatusCardText {
  headline: string
  detail: string
}

/**
 * The status card's two lines: what has been blocked this session and what the engine runs
 * with. `active` is the master switch and the level together; `pageBlocked` / `pageSite`
 * describe the current tab when it shows a web page.
 */
export function statusCardText(
  status: BlockingStatus,
  active: boolean,
  page: { blocked: number; site: string } | null,
  relativeTime: (ts: number) => string
): StatusCardText {
  if (!active) {
    return {
      headline: 'Ad and tracker blocking is off',
      detail: status.enabled
        ? 'The level is Off. Pick Basic, Balanced or Strict to block with the filter lists.'
        : 'Turn on "Block ads and trackers" to block with the filter lists.'
    }
  }
  if (!status.ready) {
    return { headline: 'Loading the filter lists…', detail: 'Blocking starts once they are read.' }
  }
  const enabledLists = status.lists.filter((l) => l.enabled)
  const filters = enabledLists.reduce((sum, l) => sum + l.filterCount, 0)
  const parts = [
    `${enabledLists.length} ${enabledLists.length === 1 ? 'list' : 'lists'}, ${count.format(filters)} filters`
  ]
  if (status.updating) parts.push('Updating lists…')
  else if (status.lastUpdatedAt)
    parts.push(`Lists updated ${inSentence(relativeTime(status.lastUpdatedAt))}`)
  else if (enabledLists.length > 0 && enabledLists.every((l) => l.bundled))
    parts.push('Using the lists bundled with this build')
  if (page) parts.push(`${count.format(page.blocked)} on ${page.site}`)
  return {
    headline: `${requests(status.sessionBlocked)} blocked since Zenium started`,
    detail: parts.join(' · ')
  }
}

/**
 * The description under a list's name: what it does, how big it is, how fresh it is. Without the
 * `blurb` (a phone's narrow row) it is the size and freshness alone, so neither is clipped away.
 */
export function listDetail(
  l: FilterListStatus,
  relativeTime: (ts: number) => string,
  { blurb = true }: { blurb?: boolean } = {}
): string {
  const parts = blurb ? [l.description] : []
  if (l.filterCount > 0) parts.push(`${count.format(l.filterCount)} filters`)
  if (l.lastError) parts.push(`Update failed: ${l.lastError}`)
  else if (l.updating) parts.push('Updating…')
  else if (l.bundled) parts.push('Bundled with this build')
  else if (l.updatedAt) parts.push(`Updated ${inSentence(relativeTime(l.updatedAt))}`)
  return parts.join(' · ')
}

/**
 * The per-list override to store when the user flips a default list: nothing when the choice
 * matches what the level would do anyway, so changing level later applies cleanly.
 */
export function listOverrides(
  settings: BlockingSettings,
  listId: string,
  enabled: boolean
): Record<string, boolean> {
  const lists = { ...settings.lists }
  if (enabled === listDefaultFor(settings.level, listId)) delete lists[listId]
  else lists[listId] = enabled
  return lists
}

/** The host to show for a stored exception origin (`https://example.com` → `example.com`). */
export function exceptionHost(origin: string): string {
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' ? url.host : `${url.protocol}//${url.host}`
  } catch {
    return origin
  }
}
