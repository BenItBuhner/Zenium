import type { Tab } from '@shared/types'
import { isEmptyTabUrl } from '@shared/url'
import type { UrlbarState } from '@renderer/lib/ui'

/**
 * Whether the phone's search-ready header (OMN-05, Chrome for Android) – the page's title and
 * address with Share, Copy link and Edit – is up: the bar edits a page (not a blank or new tab)
 * and nothing is typed yet. Typing takes it down; Edit puts the address in the field, which
 * takes it down the same way. The desktop bar never shows it.
 */
export function showsPageHeader(
  phone: boolean,
  mode: UrlbarState['mode'],
  tab: Tab | null | undefined,
  text: string
): boolean {
  if (!phone || mode !== 'edit' || !tab) return false
  return !isEmptyTabUrl(tab.url) && text === ''
}

/**
 * Whether the header offers Share for a page at `url`: http(s) pages only. Chrome disables Share
 * on schemes another app cannot open; a `zen://` (`zenium://`) page or a `file:` one is copied or
 * edited from the header but not handed to the system sheet.
 */
export function isShareableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}
