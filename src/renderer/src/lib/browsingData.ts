import type { BrowsingDataCount, BrowsingDataRange, BrowsingDataType } from '@shared/types'
import { formatBytes } from '@shared/siteInfo'
import type { MenulistOption } from '@renderer/components/siteControls/primitives'

/**
 * The words of Delete browsing data (`components/siteControls/ClearBrowsingDataDialog`, the
 * phone's `ClearBrowsingDataForm`): the range menulist, the type labels, the count line under
 * each checkbox and the toast once it is done. Chrome's verb since M124 is "Delete"
 * (`IDS_SETTINGS_CLEARED_DATA` "Data deleted.", Android's quick-delete snackbar "<period>
 * deleted"); the identifiers keep Chrome's own `clear` names, as Chrome's string ids do.
 */

/**
 * The ranges as the menulist / the sheet list them – and the one source of a range's words: the
 * toast takes its period from here (`rangeLabel`), so a range added to this list reads the same
 * in the picker and in the toast. Chrome's six, the shortest first: "Last 15 minutes" is Quick
 * Delete's default and the first entry of Chrome Android's spinner
 * (`IDS_CLEAR_BROWSING_DATA_TAB_PERIOD_15_MINUTES`, `android_chrome_strings.grd:1283–1285`;
 * `QuickDeleteDialogDelegate.java:115–118`) and the first of the desktop dialog's picker
 * (`IDS_SETTINGS_CLEAR_PERIOD_15_MINUTES`, `settings_strings.grdp:946–948`; the page's own
 * picker shortens it to "Last 15 min", `IDS_SETTINGS_CLEAR_PERIOD_15_MIN` – the dialog's full
 * word here, on every host).
 */
export const RANGE_OPTIONS: ReadonlyArray<MenulistOption<BrowsingDataRange>> = [
  { value: '15min', label: 'Last 15 minutes' },
  { value: 'hour', label: 'Last hour' },
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 4 weeks' },
  { value: 'all', label: 'All time' }
]

/** A range's label as the picker shows it. */
export function rangeLabel(range: BrowsingDataRange): string {
  return RANGE_OPTIONS.find((o) => o.value === range)?.label ?? range
}

/**
 * The range mid-sentence ("No tabs from the last 15 minutes"): the picker's label
 * (`rangeLabel`, the one source) with its capital lowered, which is what Chrome Android's
 * `IDS_QUICK_DELETE_TIME_PERIOD_*` say (`android_chrome_strings.grd:7118–7132`: "last 15
 * minutes" … "last 4 weeks").
 */
function rangeInSentence(range: BrowsingDataRange): string {
  const label = rangeLabel(range)
  return label.charAt(0).toLowerCase() + label.slice(1)
}

/**
 * The label of each type. Every `BrowsingDataType` has one; `tabs` is the phone form's row
 * (Chrome Android's Quick Delete row, `IDS_CLEAR_TABS_TITLE`, `android_chrome_strings.grd:1265–
 * 1267`), which the desktop dialog does not list.
 */
export const TYPE_LABEL: Record<BrowsingDataType, string> = {
  history: 'Browsing history',
  cookies: 'Cookies and site data',
  cache: 'Cached images and files',
  downloads: 'Download history',
  passwords: 'Saved passwords',
  autofill: 'Autofill form data',
  sitePermissions: 'Site settings',
  recentlyClosed: 'Recently closed tabs',
  tabs: 'Tabs'
}

/**
 * The toast once the clear is done, in Chrome Android's quick-delete shape on every host: the
 * period as the picker names it, then "deleted" – "Last hour deleted", "Last 4 weeks deleted" –
 * and "Deleted" alone for all time (`IDS_QUICK_DELETE_SNACKBAR_MESSAGE` "<TIME_PERIOD> deleted",
 * `IDS_QUICK_DELETE_SNACKBAR_ALL_TIME_MESSAGE` "Deleted"; the period is the picker's own string,
 * `TimePeriodUtils.getTimePeriodString` → `IDS_CLEAR_BROWSING_DATA_TAB_PERIOD_*`). A catalogue
 * line (§9.33): no full stop. The types the user ticked are the form's, not the toast's; the
 * result's list only says whether anything went at all – "Nothing deleted" when it did not.
 */
export function clearedToast(
  range: BrowsingDataRange,
  cleared: readonly BrowsingDataType[]
): string {
  if (cleared.length === 0) return 'Nothing deleted'
  if (range === 'all') return 'Deleted'
  return `${rangeLabel(range)} deleted`
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
    permissions: ['permission', 'permissions'],
    tabs: ['tab', 'tabs']
  }
  if (c.unit === 'tabs') return tabsLine(c.count, range, unit.tabs)
  const [one, many] = unit[c.unit]
  const prefix = c.unit === 'sites' ? 'From ' : ''
  return `${prefix}${c.count.toLocaleString()} ${c.count === 1 ? one : many}${scope}`
}

/**
 * The Tabs row's line, Chrome Android's Quick Delete words: "{1 tab on this device|# tabs on
 * this device}" (`IDS_QUICK_DELETE_DIALOG_TABS_CLOSED_TEXT`, `android_chrome_strings.grd:7071–
 * 7073`); with none, "No tabs on this device" for all time
 * (`IDS_QUICK_DELETE_DIALOG_ZERO_TABS_CLOSED_ALL_TIME_TEXT`, `:7077–7079`) and "No tabs from the
 * <period>" for a bounded range (`IDS_QUICK_DELETE_DIALOG_ZERO_TABS_CLOSED_TEXT`, `:7080–7082`).
 * `words` is `countLine`'s own pair for the unit, so the two lines cannot drift apart.
 */
function tabsLine(count: number, range: BrowsingDataRange, words: [string, string]): string {
  if (count === 0) {
    return range === 'all' ? 'No tabs on this device' : `No tabs from the ${rangeInSentence(range)}`
  }
  const [one, many] = words
  return `${count.toLocaleString()} ${count === 1 ? one : many} on this device`
}
