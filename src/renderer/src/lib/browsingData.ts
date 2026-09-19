import type { BrowsingDataCount, BrowsingDataRange, BrowsingDataType } from '@shared/types'
import { formatBytes } from '@shared/siteInfo'
import type { MenulistOption } from '@renderer/components/siteControls/primitives'

/**
 * The words of Clear browsing data (`components/siteControls/ClearBrowsingDataDialog`): the range
 * menulist, the type labels, the count line under each checkbox and the toast once it is done.
 */

export const RANGE_OPTIONS: ReadonlyArray<MenulistOption<BrowsingDataRange>> = [
  { value: 'hour', label: 'Last hour' },
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 4 weeks' },
  { value: 'all', label: 'All time' }
]

export const TYPE_LABEL: Record<BrowsingDataType, string> = {
  history: 'Browsing history',
  cookies: 'Cookies and site data',
  cache: 'Cached images and files',
  downloads: 'Download history',
  passwords: 'Saved passwords',
  autofill: 'Autofill form data',
  sitePermissions: 'Site settings',
  recentlyClosed: 'Recently closed tabs'
}

/** "Cleared history, cookies and cache" */
export function clearedToast(cleared: BrowsingDataType[]): string {
  const words: Record<BrowsingDataType, string> = {
    history: 'history',
    cookies: 'cookies and site data',
    cache: 'the cache',
    downloads: 'download history',
    passwords: 'saved passwords',
    autofill: 'autofill data',
    sitePermissions: 'site settings',
    recentlyClosed: 'recently closed tabs'
  }
  if (cleared.length === 0) return 'Nothing to clear'
  const list = cleared.map((t) => words[t])
  const text =
    list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  return `Cleared ${text}`
}

/** The line under a type's checkbox: how much the range holds, or why it cannot go now. */
export function countLine(
  type: BrowsingDataType,
  counts: BrowsingDataCount[] | null,
  range: BrowsingDataRange
): string {
  if (counts === null) return 'Counting…'
  const c = counts.find((x) => x.type === type)
  if (!c) return ''
  if (c.unavailable) return c.unavailable
  // A type the engine cannot limit to the range goes entirely, whatever the range says.
  const whole = !c.rangeApplies && range !== 'all'
  if (c.count === null) return whole ? 'All of it, from all time' : ''
  const scope = whole ? ' (all time)' : ''
  if (c.unit === 'bytes') return `${formatBytes(c.count)}${scope}`
  const unit: Record<Exclude<BrowsingDataCount['unit'], 'bytes'>, [string, string]> = {
    visits: ['visit', 'visits'],
    sites: ['site', 'sites'],
    downloads: ['download', 'downloads'],
    logins: ['login', 'logins'],
    entries: ['entry', 'entries'],
    permissions: ['permission', 'permissions']
  }
  const [one, many] = unit[c.unit]
  const prefix = c.unit === 'sites' ? 'From ' : ''
  return `${prefix}${c.count.toLocaleString()} ${c.count === 1 ? one : many}${scope}`
}
